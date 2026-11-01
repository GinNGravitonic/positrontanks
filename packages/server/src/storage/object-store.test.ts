import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../config.js";
import { checkObjectStorage, createObjectStore } from "./create.js";
import { LocalObjectStore } from "./local-object-store.js";
import { InvalidKeyError, type ObjectStore } from "./object-store.js";
import { S3ObjectStore } from "./s3-object-store.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined): string | undefined =>
  data === undefined ? undefined : new TextDecoder().decode(data);

/**
 * An in-memory S3 bucket behind aws-sdk-client-mock: the real S3Client and
 * command objects, with `send` answered from a Map. Listing returns at most
 * `pageSize` keys per page so pagination is exercised.
 */
function fakeS3(pageSize = 2): { client: S3Client; objects: Map<string, Uint8Array>; restore: () => void } {
  const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const objects = new Map<string, Uint8Array>();
  const mock = mockClient(client);
  const missing = (key: string | undefined) => ({ message: `No object ${String(key)}`, $metadata: { httpStatusCode: 404 } });

  mock.on(PutObjectCommand).callsFake((input: { Key?: string; Body?: unknown }) => {
    if (!(input.Body instanceof Uint8Array)) throw new Error("fake S3 only accepts Uint8Array bodies");
    objects.set(input.Key ?? "", Uint8Array.from(input.Body));
    return {};
  });
  mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => {
    const data = objects.get(input.Key ?? "");
    if (data === undefined) throw new NoSuchKey(missing(input.Key));
    const body = { transformToByteArray: () => Promise.resolve(Uint8Array.from(data)) };
    return { Body: body };
  });
  mock.on(HeadObjectCommand).callsFake((input: { Key?: string }) => {
    if (!objects.has(input.Key ?? "")) throw new NotFound(missing(input.Key));
    return {};
  });
  mock.on(DeleteObjectCommand).callsFake((input: { Key?: string }) => {
    objects.delete(input.Key ?? "");
    return {};
  });
  mock.on(ListObjectsV2Command).callsFake((input: { Prefix?: string; ContinuationToken?: string }) => {
    const matching = [...objects.keys()].filter((k) => k.startsWith(input.Prefix ?? "")).sort();
    const start = input.ContinuationToken === undefined ? 0 : Number(input.ContinuationToken);
    const page = matching.slice(start, start + pageSize);
    const truncated = start + pageSize < matching.length;
    return {
      Contents: page.map((Key) => ({ Key })),
      IsTruncated: truncated,
      ...(truncated ? { NextContinuationToken: String(start + pageSize) } : {}),
    };
  });
  return {
    client,
    objects,
    restore: () => {
      mock.restore();
    },
  };
}

interface Backend {
  readonly name: string;
  readonly open: () => Promise<{ store: ObjectStore; close: () => Promise<void> }>;
}

const backends: readonly Backend[] = [
  {
    name: "LocalObjectStore",
    open: async () => {
      const root = await mkdtemp(join(tmpdir(), "positrontanks-objects-"));
      return { store: new LocalObjectStore(root), close: () => rm(root, { recursive: true, force: true }) };
    },
  },
  {
    name: "S3ObjectStore",
    open: () => {
      const s3 = fakeS3();
      const store = new S3ObjectStore({ client: s3.client, bucket: "test-bucket", keyPrefix: "objects/" });
      const close = (): Promise<void> => {
        s3.restore();
        return Promise.resolve();
      };
      return Promise.resolve({ store, close });
    },
  },
];

describe.each(backends)("ObjectStore contract: $name", (backend) => {
  let store: ObjectStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ store, close } = await backend.open());
  });
  afterEach(async () => {
    await close();
  });

  it("returns what was put", async () => {
    await store.put("games/g1/record.json", bytes('{"seed":1}'));
    expect(text(await store.get("games/g1/record.json"))).toBe('{"seed":1}');
    expect(await store.exists("games/g1/record.json")).toBe(true);
  });

  it("round-trips arbitrary and empty bodies", async () => {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    await store.put("images/a.png", binary);
    await store.put("empty", new Uint8Array());
    expect(await store.get("images/a.png")).toEqual(binary);
    expect(await store.get("empty")).toEqual(new Uint8Array());
  });

  it("does not alias the caller's buffer", async () => {
    const body = bytes("abc");
    await store.put("k", body);
    body[0] = 0x7a;
    expect(text(await store.get("k"))).toBe("abc");
  });

  it("overwrites an existing object", async () => {
    await store.put("games/g1/replay.json", bytes("old"));
    await store.put("games/g1/replay.json", bytes("new"));
    expect(text(await store.get("games/g1/replay.json"))).toBe("new");
  });

  it("reports missing objects", async () => {
    expect(await store.get("games/missing")).toBeUndefined();
    expect(await store.exists("games/missing")).toBe(false);
  });

  it("treats a key prefix as no object", async () => {
    await store.put("games/g1/record.json", bytes("x"));
    expect(await store.get("games/g1")).toBeUndefined();
    expect(await store.exists("games/g1")).toBe(false);
    expect(await store.get("games/g1/record.json/more")).toBeUndefined();
    expect(await store.exists("games/g1/record.json/more")).toBe(false);
  });

  it("deletes, idempotently", async () => {
    await store.put("games/g1/record.json", bytes("x"));
    await store.delete("games/g1/record.json");
    expect(await store.exists("games/g1/record.json")).toBe(false);
    await store.delete("games/g1/record.json");
    await store.delete("never/existed");
    expect(await store.list()).toEqual([]);
  });

  it("lists keys by prefix in order", async () => {
    for (const key of ["games/g2/record.json", "games/g1/replay.json", "games/g1/record.json", "games/g10/x", "images/i1"]) {
      await store.put(key, bytes(key));
    }
    expect(await store.list()).toEqual([
      "games/g1/record.json",
      "games/g1/replay.json",
      "games/g10/x",
      "games/g2/record.json",
      "images/i1",
    ]);
    expect(await store.list("games/g1/")).toEqual(["games/g1/record.json", "games/g1/replay.json"]);
    expect(await store.list("games/g1")).toEqual(["games/g1/record.json", "games/g1/replay.json", "games/g10/x"]);
    expect(await store.list("games/g1/rep")).toEqual(["games/g1/replay.json"]);
    expect(await store.list("images/")).toEqual(["images/i1"]);
    expect(await store.list("nothing/")).toEqual([]);
    expect(await store.list("images/i1")).toEqual(["images/i1"]);
  });

  it.each([
    "",
    "/abs",
    "trailing/",
    "a//b",
    "..",
    "a/../b",
    "./a",
    "a/.hidden",
    "back\\slash",
    "C:/x",
    "sp ace",
    "nul\0",
    "x".repeat(513),
  ])("rejects the key %j", async (key) => {
    await expect(store.put(key, bytes("x"))).rejects.toThrow(InvalidKeyError);
    await expect(store.get(key)).rejects.toThrow(InvalidKeyError);
    await expect(store.exists(key)).rejects.toThrow(InvalidKeyError);
    await expect(store.delete(key)).rejects.toThrow(InvalidKeyError);
  });

  it.each(["/", "../", "a/../", "a//", ".."])("rejects the list prefix %j", async (prefix) => {
    await expect(store.list(prefix)).rejects.toThrow(InvalidKeyError);
  });
});

describe("LocalObjectStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "positrontanks-objects-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores keys as nested files and prunes emptied directories", async () => {
    const store = new LocalObjectStore(root);
    await store.put("games/g1/record.json", bytes("x"));
    expect(await readdir(join(root, "games", "g1"))).toEqual(["record.json"]);
    await store.delete("games/g1/record.json");
    expect(await readdir(root)).toEqual([]);
  });

  it("never writes outside its root", async () => {
    const store = new LocalObjectStore(join(root, "objects"));
    await expect(store.put("../escape", bytes("x"))).rejects.toThrow(InvalidKeyError);
    await expect(store.put("..\\escape", bytes("x"))).rejects.toThrow(InvalidKeyError);
    expect(await readdir(root)).toEqual([]);
  });

  it("ignores stray files that are not valid keys", async () => {
    const store = new LocalObjectStore(root);
    await store.put("a/b", bytes("x"));
    await writeFile(join(root, "a", ".tmp-leftover"), "partial");
    expect(await store.list()).toEqual(["a/b"]);
  });

  it("lists nothing when the root does not exist yet", async () => {
    expect(await new LocalObjectStore(join(root, "absent")).list()).toEqual([]);
  });
});

describe("S3ObjectStore", () => {
  it("namespaces keys under its key prefix", async () => {
    const s3 = fakeS3();
    try {
      s3.objects.set("other/thing", bytes("not ours"));
      const store = new S3ObjectStore({ client: s3.client, bucket: "b", keyPrefix: "objects/" });
      await store.put("games/g1/record.json", bytes("x"));
      expect([...s3.objects.keys()].sort()).toEqual(["objects/games/g1/record.json", "other/thing"]);
      expect(await store.list()).toEqual(["games/g1/record.json"]);
    } finally {
      s3.restore();
    }
  });

  it("rejects a key prefix not ending in /", () => {
    const s3 = fakeS3();
    try {
      expect(() => new S3ObjectStore({ client: s3.client, bucket: "b", keyPrefix: "objects" })).toThrow(/key prefix/);
    } finally {
      s3.restore();
    }
  });

  it("propagates errors other than not-found", async () => {
    const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "t", secretAccessKey: "t" } });
    const mock = mockClient(client);
    try {
      mock.on(GetObjectCommand).rejects(new Error("AccessDenied"));
      mock.on(HeadObjectCommand).rejects(new Error("AccessDenied"));
      const store = new S3ObjectStore({ client, bucket: "b" });
      await expect(store.get("k")).rejects.toThrow("AccessDenied");
      await expect(store.exists("k")).rejects.toThrow("AccessDenied");
    } finally {
      mock.restore();
    }
  });
});

describe("createObjectStore", () => {
  it("builds the backend the configuration selects", () => {
    expect(createObjectStore(loadConfig({}).storage)).toBeInstanceOf(LocalObjectStore);
    const s3 = loadConfig({ POSITRONTANKS_STORAGE: "s3", POSITRONTANKS_S3_BUCKET: "b", POSITRONTANKS_S3_REGION: "eu-west-1" }).storage;
    expect(createObjectStore(s3)).toBeInstanceOf(S3ObjectStore);
  });
});

describe("checkObjectStorage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "positrontanks-check-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a usable local directory and leaves nothing behind", async () => {
    const directory = join(dir, "nested", "objects");
    await checkObjectStorage({ kind: "local", directory });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects a local directory that cannot be created, naming the variable and path", async () => {
    await writeFile(join(dir, "file"), "not a directory");
    const directory = join(dir, "file", "objects");
    const check = checkObjectStorage({ kind: "local", directory });
    await expect(check).rejects.toBeInstanceOf(ConfigError);
    await expect(check).rejects.toThrow(`POSITRONTANKS_STORAGE_DIRECTORY "${directory}" cannot be created or written`);
  });

  it("does not touch S3", async () => {
    await expect(
      checkObjectStorage(loadConfig({ POSITRONTANKS_STORAGE: "s3", POSITRONTANKS_S3_BUCKET: "b" }).storage),
    ).resolves.toBeUndefined();
  });
});

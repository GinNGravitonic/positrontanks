import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { IMAGE_MAX_BYTES } from "../images/png.js";
import { ihdr, png, pngChunk, rgbaIdat, samplePng, textChunk } from "../images/sample-png.js";
import { emblemKey } from "./emblems.js";

const quiet: Logger = { info: () => undefined, error: () => undefined };

let dir: string;
let running: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "positrontanks-emblems-"));
  const config: ServerConfig = {
    ...defaultConfig,
    port: 0,
    databasePath: ":memory:",
    storage: { kind: "local", directory: join(dir, "objects") },
  };
  running = await startServer(config, { logger: quiet });
});

afterEach(async () => {
  await running.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Response {
  status: number;
  headers: Headers;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; bytes?: Uint8Array; type?: string; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.bytes !== undefined) headers["content-type"] = options.type ?? "image/png";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(running.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.bytes === undefined ? {} : { body: options.bytes }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? undefined : JSON.parse(text) };
}

async function fetchEmblem(token: string, playerId: string, hash: string): Promise<globalThis.Response> {
  return fetch(`${running.url}/players/${playerId}/emblem/${hash}`, { headers: { authorization: `Bearer ${token}` } });
}

const errorOf = (response: Response): { code: string; details?: { path: string; message: string }[] } =>
  (response.body as { error: { code: string; details?: { path: string; message: string }[] } }).error;

interface Player {
  id: string;
  username: string;
  emblem: string | null;
}

async function player(username: string): Promise<{ token: string; id: string }> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  const session = (await call("POST", "/sessions", { body: { username, password } })).body as {
    token: string;
    player: Player;
  };
  return { token: session.token, id: session.player.id };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function setEmblem(token: string, bytes: Uint8Array): Promise<string> {
  const response = await call("PUT", "/players/me/emblem", { token, bytes });
  expect(response.status).toBe(200);
  return (response.body as Player).emblem ?? "";
}

describe("setting an Emblem", () => {
  it("stores the PNG and reports its hash on the Player", async () => {
    const ada = await player("ada");
    expect(((await call("GET", "/players/me", { token: ada.token })).body as Player).emblem).toBeNull();

    const file = samplePng(64);
    const response = await call("PUT", "/players/me/emblem", { token: ada.token, bytes: file });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: ada.id, username: "ada", emblem: sha256(file) });
    expect(((await call("GET", "/players/me", { token: ada.token })).body as Player).emblem).toBe(sha256(file));

    const image = await fetchEmblem(ada.token, ada.id, sha256(file));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(file);
  });

  it("strips metadata chunks before storing", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng(32, textChunk("Author", "Ada Lovelace")));
    const clean = samplePng(32);
    expect(hash).toBe(sha256(clean));
    const image = await fetchEmblem(ada.token, ada.id, hash);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(clean);
  });

  it("deletes the old image when replacing it", async () => {
    const ada = await player("ada");
    const first = await setEmblem(ada.token, samplePng(32));
    const second = await setEmblem(ada.token, samplePng(48));
    expect(second).not.toBe(first);
    expect(await running.services.objects.list(`emblems/${ada.id}/`)).toEqual([emblemKey(ada.id, second)]);
    expect((await fetchEmblem(ada.token, ada.id, first)).status).toBe(404);
    expect((await fetchEmblem(ada.token, ada.id, second)).status).toBe(200);
  });

  it("keeps the image when the same one is uploaded again", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng(32));
    expect(await setEmblem(ada.token, samplePng(32))).toBe(hash);
    expect((await fetchEmblem(ada.token, ada.id, hash)).status).toBe(200);
  });

  it("rejects files that are not acceptable PNGs", async () => {
    const ada = await player("ada");
    const corrupt = samplePng(32);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;
    const files: [Uint8Array, RegExp][] = [
      [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), /not a PNG/],
      [png(ihdr(64, 32), rgbaIdat(64, 32), pngChunk("IEND")), /square/],
      [samplePng(16), /32 to 256/],
      [samplePng(512), /32 to 256/],
      [corrupt, /CRC/],
    ];
    for (const [bytes, message] of files) {
      const response = await call("PUT", "/players/me/emblem", { token: ada.token, bytes });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("validation_failed");
      expect(errorOf(response).details?.[0]?.message).toMatch(message);
    }
    expect(((await call("GET", "/players/me", { token: ada.token })).body as Player).emblem).toBeNull();
    expect(await running.services.objects.list("emblems/")).toEqual([]);
  });

  it("rejects an oversized body and the wrong content type", async () => {
    const ada = await player("ada");
    const big = samplePng(64, pngChunk("zzZz", new Uint8Array(IMAGE_MAX_BYTES)));
    const tooLarge = await call("PUT", "/players/me/emblem", { token: ada.token, bytes: big });
    expect(tooLarge.status).toBe(413);
    expect(errorOf(tooLarge).code).toBe("payload_too_large");

    const wrongType = await call("PUT", "/players/me/emblem", { token: ada.token, bytes: samplePng(), type: "image/gif" });
    expect(wrongType.status).toBe(415);
  });

  it("requires authentication", async () => {
    expect((await call("PUT", "/players/me/emblem", { bytes: samplePng() })).status).toBe(401);
    expect((await call("DELETE", "/players/me/emblem")).status).toBe(401);
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng());
    expect((await fetch(`${running.url}/players/${ada.id}/emblem/${hash}`)).status).toBe(401);
  });
});

describe("removing an Emblem", () => {
  it("clears the field and deletes the image", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng());
    expect((await call("DELETE", "/players/me/emblem", { token: ada.token })).status).toBe(204);
    expect(((await call("GET", "/players/me", { token: ada.token })).body as Player).emblem).toBeNull();
    expect((await fetchEmblem(ada.token, ada.id, hash)).status).toBe(404);
    expect(await running.services.objects.list("emblems/")).toEqual([]);
  });

  it("is not an error without an Emblem", async () => {
    const ada = await player("ada");
    expect((await call("DELETE", "/players/me/emblem", { token: ada.token })).status).toBe(204);
  });
});

describe("fetching an Emblem", () => {
  it("lets any authenticated Player fetch another's Emblem", async () => {
    const ada = await player("ada");
    const bob = await player("bob");
    const hash = await setEmblem(ada.token, samplePng());
    expect((await fetchEmblem(bob.token, ada.id, hash)).status).toBe(200);
    // The hash belongs to Ada's Emblem, not Bob's.
    expect((await fetchEmblem(bob.token, bob.id, hash)).status).toBe(404);
  });

  it("answers 404 once the stored image is deleted out of band", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng());
    await running.services.objects.delete(emblemKey(ada.id, hash));
    const response = await fetchEmblem(ada.token, ada.id, hash);
    expect(response.status).toBe(404);
  });

  it("answers 404 for unknown Players and malformed hashes", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng());
    expect((await fetchEmblem(ada.token, "nobody", hash)).status).toBe(404);
    expect((await fetchEmblem(ada.token, "..", hash)).status).toBe(404);
    expect((await fetchEmblem(ada.token, ada.id, "abc")).status).toBe(404);
    expect((await fetchEmblem(ada.token, ada.id, hash.toUpperCase())).status).toBe(404);
  });
});

describe("Player references", () => {
  type MapContent = Record<string, unknown>;
  const DUEL = JSON.parse(
    readFileSync(new URL("../../../ruleset-data/maps/duel.json", import.meta.url), "utf8"),
  ) as MapContent;

  it("carry the current Emblem on logging in, Maps and Games", async () => {
    const ada = await player("ada");
    const hash = await setEmblem(ada.token, samplePng());
    const expected = { id: ada.id, username: "ada", emblem: hash };

    const session = await call("POST", "/sessions", { body: { username: "ada", password: "correct horse battery" } });
    expect((session.body as { player: Player }).player).toMatchObject(expected);

    const map = await call("POST", "/maps", { token: ada.token, body: { name: "Arena", map: DUEL } });
    expect(map.status).toBe(201);
    const mapId = (map.body as { id: string }).id;
    expect((map.body as { creator: Player }).creator).toEqual(expected);

    const game = await call("POST", "/games", {
      token: ada.token,
      body: {
        rulesetVersion: "r1",
        mapId,
        playerCount: 2,
        pointBudget: 100,
        timeLimitSeconds: 120,
        pace: "unthrottled",
        fillTimeoutSeconds: 600,
      },
    });
    expect(game.status).toBe(201);
    expect((game.body as { initiator: Player }).initiator).toEqual(expected);

    // Always the current Emblem, never a copy.
    await call("DELETE", "/players/me/emblem", { token: ada.token });
    const again = await call("GET", `/maps/${mapId}`, { token: ada.token });
    expect((again.body as { creator: Player }).creator.emblem).toBeNull();
  });
});

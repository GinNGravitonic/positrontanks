import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R1_LANGUAGE } from "@positrontanks/language";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { IMAGE_MAX_BYTES } from "../images/png.js";
import { ihdr, png, pngChunk, rgbaIdat, samplePng, textChunk } from "../images/sample-png.js";
import { engineR1Ruleset, RulesetCatalog } from "../rulesets/catalog.js";
import { iconKey } from "./icons.js";

const quiet: Logger = { info: () => undefined, error: () => undefined };

const r1 = loadRuleset("r1");
/** A second Ruleset version to copy designs into. */
const r1x = { ...engineR1Ruleset({ ...r1, version: "r1x" }), language: { ...R1_LANGUAGE, version: "r1x" } };

const DUEL = JSON.parse(readFileSync(new URL("../../../ruleset-data/maps/duel.json", import.meta.url), "utf8")) as unknown;

let dir: string;
let running: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "positrontanks-icons-"));
  const config: ServerConfig = {
    ...defaultConfig,
    port: 0,
    databasePath: ":memory:",
    storage: { kind: "local", directory: join(dir, "objects") },
    // No unthrottled Game is played, so the Games filled here stay Running.
    limits: { ...defaultConfig.limits, maxConcurrentUnthrottledGames: 0 },
  };
  running = await startServer(config, { logger: quiet, rulesets: new RulesetCatalog([engineR1Ruleset(r1), r1x]) });
});

afterEach(async () => {
  await running.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Response {
  status: number;
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
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const fetchIcon = (token: string, hash: string): Promise<globalThis.Response> =>
  fetch(`${running.url}/icons/${hash}`, { headers: { authorization: `Bearer ${token}` } });

const errorOf = (response: Response): { code: string; details?: { path: string; message: string }[] } =>
  (response.body as { error: { code: string; details?: { path: string; message: string }[] } }).error;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

const noArmor = { front: null, left: null, right: null, rear: null };
/** Scout + pellet gun + wheels = 64 points. */
const CHEAP_BUILD = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
const PROGRAM = `function tick() { throttle(1); fire("gun", 0); }`;

interface Design {
  id: string;
  icon: string | null;
  latestRevision: { number: number };
  updatedAt: string;
}

async function design(token: string): Promise<string> {
  const response = await call("POST", "/bot-designs", {
    token,
    body: { name: "Scout", rulesetVersion: "r1", build: CHEAP_BUILD, program: PROGRAM },
  });
  expect(response.status).toBe(201);
  return (response.body as Design).id;
}

async function getDesign(token: string, id: string): Promise<Design> {
  const response = await call("GET", `/bot-designs/${id}`, { token });
  expect(response.status).toBe(200);
  return response.body as Design;
}

async function setIcon(token: string, designId: string, bytes: Uint8Array): Promise<string> {
  const response = await call("PUT", `/bot-designs/${designId}/icon`, { token, bytes });
  expect(response.status).toBe(200);
  return (response.body as Design).icon ?? "";
}

describe("setting an Icon", () => {
  it("stores the PNG, reports its hash on the design and adds no Revision", async () => {
    const ada = await player("ada");
    const id = await design(ada);
    expect((await getDesign(ada, id)).icon).toBeNull();

    const file = samplePng(64);
    const response = await call("PUT", `/bot-designs/${id}/icon`, { token: ada, bytes: file });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id, icon: sha256(file), latestRevision: { number: 1 } });
    expect((await getDesign(ada, id)).icon).toBe(sha256(file));
    const listed = (await call("GET", "/bot-designs", { token: ada })).body as { botDesigns: Design[] };
    expect(listed.botDesigns.map((d) => d.icon)).toEqual([sha256(file)]);
    const revisions = (await call("GET", `/bot-designs/${id}/revisions`, { token: ada })).body as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
    expect(await running.services.objects.list("icons/")).toEqual([iconKey(sha256(file))]);
  });

  it("strips metadata chunks before storing", async () => {
    const ada = await player("ada");
    const hash = await setIcon(ada, await design(ada), samplePng(32, textChunk("Author", "Ada Lovelace")));
    const clean = samplePng(32);
    expect(hash).toBe(sha256(clean));
    expect(new Uint8Array(await (await fetchIcon(ada, hash)).arrayBuffer())).toEqual(clean);
  });

  it("deletes the old image when replacing it", async () => {
    const ada = await player("ada");
    const id = await design(ada);
    const first = await setIcon(ada, id, samplePng(32));
    const second = await setIcon(ada, id, samplePng(48));
    expect(second).not.toBe(first);
    expect(await running.services.objects.list("icons/")).toEqual([iconKey(second)]);
    expect((await fetchIcon(ada, first)).status).toBe(404);
    expect(await setIcon(ada, id, samplePng(48))).toBe(second);
    expect((await fetchIcon(ada, second)).status).toBe(200);
  });

  it("rejects files that are not acceptable PNGs", async () => {
    const ada = await player("ada");
    const id = await design(ada);
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
      const response = await call("PUT", `/bot-designs/${id}/icon`, { token: ada, bytes });
      expect(response.status).toBe(422);
      expect(errorOf(response).code).toBe("validation_failed");
      expect(errorOf(response).details?.[0]?.message).toMatch(message);
    }

    const big = samplePng(64, pngChunk("zzZz", new Uint8Array(IMAGE_MAX_BYTES)));
    expect((await call("PUT", `/bot-designs/${id}/icon`, { token: ada, bytes: big })).status).toBe(413);
    const gif = await call("PUT", `/bot-designs/${id}/icon`, { token: ada, bytes: samplePng(), type: "image/gif" });
    expect(gif.status).toBe(415);

    expect((await getDesign(ada, id)).icon).toBeNull();
    expect(await running.services.objects.list("icons/")).toEqual([]);
  });

  it("answers 404 for other Players' designs and requires authentication", async () => {
    const ada = await player("ada");
    const bob = await player("bob");
    const id = await design(ada);
    const hash = await setIcon(ada, id, samplePng(32));

    const put = await call("PUT", `/bot-designs/${id}/icon`, { token: bob, bytes: samplePng(48) });
    expect(put.status).toBe(404);
    expect((await call("PUT", "/bot-designs/nope/icon", { token: bob, bytes: samplePng(48) })).status).toBe(404);
    expect((await call("DELETE", `/bot-designs/${id}/icon`, { token: bob })).status).toBe(404);
    expect((await getDesign(ada, id)).icon).toBe(hash);
    expect(await running.services.objects.list("icons/")).toEqual([iconKey(hash)]);

    expect((await call("PUT", `/bot-designs/${id}/icon`, { bytes: samplePng() })).status).toBe(401);
    expect((await call("DELETE", `/bot-designs/${id}/icon`)).status).toBe(401);
  });

  it("is allowed on archived designs", async () => {
    const ada = await player("ada");
    const id = await design(ada);
    expect((await call("DELETE", `/bot-designs/${id}`, { token: ada })).status).toBe(204);
    const hash = await setIcon(ada, id, samplePng(32));
    expect((await getDesign(ada, id)).icon).toBe(hash);
    expect((await call("DELETE", `/bot-designs/${id}/icon`, { token: ada })).status).toBe(204);
    expect((await getDesign(ada, id)).icon).toBeNull();
  });
});

describe("removing an Icon", () => {
  it("clears the field and deletes the image", async () => {
    const ada = await player("ada");
    const id = await design(ada);
    const hash = await setIcon(ada, id, samplePng());
    expect((await call("DELETE", `/bot-designs/${id}/icon`, { token: ada })).status).toBe(204);
    expect((await getDesign(ada, id)).icon).toBeNull();
    expect((await fetchIcon(ada, hash)).status).toBe(404);
    expect(await running.services.objects.list("icons/")).toEqual([]);
  });

  it("is not an error without an Icon", async () => {
    const ada = await player("ada");
    expect((await call("DELETE", `/bot-designs/${await design(ada)}/icon`, { token: ada })).status).toBe(204);
  });
});

describe("shared images", () => {
  it("keeps an image until no design references its hash", async () => {
    const ada = await player("ada");
    const bob = await player("bob");
    const adas = await design(ada);
    const bobs = await design(bob);
    const hash = await setIcon(ada, adas, samplePng(32));
    expect(await setIcon(bob, bobs, samplePng(32))).toBe(hash);

    // Replacing one keeps the image the other still uses.
    const other = await setIcon(ada, adas, samplePng(48));
    expect((await fetchIcon(bob, hash)).status).toBe(200);
    expect((await call("DELETE", `/bot-designs/${bobs}/icon`, { token: bob })).status).toBe(204);
    expect(await running.services.objects.list("icons/")).toEqual([iconKey(other)]);
  });

  it("are kept by Copy to Ruleset", async () => {
    const ada = await player("ada");
    const id = await design(ada);
    const hash = await setIcon(ada, id, samplePng(32));
    const copied = await call("POST", `/bot-designs/${id}/copies`, { token: ada, body: { rulesetVersion: "r1x" } });
    expect(copied.status).toBe(201);
    const copy = (copied.body as { botDesign: Design }).botDesign;
    expect(copy.icon).toBe(hash);

    expect((await call("DELETE", `/bot-designs/${id}/icon`, { token: ada })).status).toBe(204);
    expect((await getDesign(ada, copy.id)).icon).toBe(hash);
    expect((await fetchIcon(ada, hash)).status).toBe(200);
  });
});

describe("fetching an Icon", () => {
  it("lets any authenticated Player fetch it, with caching headers", async () => {
    const ada = await player("ada");
    const bob = await player("bob");
    const file = samplePng(64);
    const hash = await setIcon(ada, await design(ada), file);

    const image = await fetchIcon(bob, hash);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(file);

    expect((await fetch(`${running.url}/icons/${hash}`)).status).toBe(401);
  });

  it("answers 404 for malformed hashes and missing images", async () => {
    const ada = await player("ada");
    const hash = await setIcon(ada, await design(ada), samplePng());
    expect((await fetchIcon(ada, "abc")).status).toBe(404);
    expect((await fetchIcon(ada, hash.toUpperCase())).status).toBe(404);
    expect((await fetchIcon(ada, "0".repeat(64))).status).toBe(404);

    // Taken down by deleting the stored object.
    await running.services.objects.delete(iconKey(hash));
    expect((await fetchIcon(ada, hash)).status).toBe(404);
  });
});

describe("Game Entries", () => {
  interface Game {
    id: string;
    state: string;
    entries: { player: { username: string }; bots: { name: string; icon?: string | null }[] }[];
  }

  it("carry the design's current Icon wherever the Build is shown", async () => {
    const ada = await player("ada");
    const bob = await player("bob");
    const adas = await design(ada);
    const bobs = await design(bob);
    const hash = await setIcon(ada, adas, samplePng(32));

    const map = await call("POST", "/maps", { token: ada, body: { name: "Arena", map: DUEL } });
    const game = await call("POST", "/games", {
      token: ada,
      body: {
        rulesetVersion: "r1",
        mapId: (map.body as { id: string }).id,
        playerCount: 2,
        pointBudget: 100,
        timeLimitSeconds: 120,
        pace: "unthrottled",
        fillTimeoutSeconds: 600,
      },
    });
    const gameId = (game.body as Game).id;
    const enter = (token: string, designId: string, name: string) =>
      call("POST", `/games/${gameId}/entries`, { token, body: { bots: [{ designId, name }] } });
    const view = async (token: string): Promise<Game> => (await call("GET", `/games/${gameId}`, { token })).body as Game;

    expect((await enter(ada, adas, "Rex")).status).toBe(201);
    // While Open, the owner sees the Icon and others see only the Bot Name.
    expect((await view(ada)).entries[0]?.bots[0]).toMatchObject({ name: "Rex", icon: hash });
    expect((await view(bob)).entries[0]?.bots[0]).toEqual({ name: "Rex" });

    expect((await enter(bob, bobs, "Dino")).status).toBe(201);
    const started = await view(bob);
    expect(started.state).toBe("running");
    expect(started.entries.map((e) => e.bots[0]?.icon)).toEqual([hash, null]);

    // Always the design's Icon now, not when it was entered.
    const other = await setIcon(ada, adas, samplePng(48));
    expect((await view(bob)).entries[0]?.bots[0]?.icon).toBe(other);
  });
});

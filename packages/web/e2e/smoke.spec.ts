/**
 * The web client's smoke test (docs/spec/frontend.md section 9): against a
 * local server serving the built client, a Player logs in, opens a Finished
 * Game's Replay and reaches Game Over, where a Player with an Emblem shows
 * it and one without shows the placeholder.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { defaultConfig, startServer, type RunningServer } from "@positrontanks/server";

const PASSWORD = "correct horse battery";
const noArmor = { front: null, left: null, right: null, rear: null };
const BUILD = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
/** Charges forward, weaving a little, firing straight ahead. */
const PROGRAM = 'function tick() { throttle(1); turn(random() * 0.2 - 0.1); fire("gun", 0); }';

let dir: string;
let server: RunningServer;
let gameId: string;

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(server.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** Signs `username` up and returns a session token. */
async function player(username: string): Promise<string> {
  await call("POST", "/players", { username, password: PASSWORD });
  return (await call<{ token: string }>("POST", "/sessions", { username, password: PASSWORD })).token;
}

const created = async (token: string, path: string, body: unknown) => (await call<{ id: string }>("POST", path, body, token)).id;

/** A `size` x `size` PNG, all opaque red. */
function redPng(size: number): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Each row: filter type 0, then RGB pixels.
  const row = Buffer.concat([Buffer.of(0), Buffer.alloc(size * 3, Buffer.of(255, 0, 0))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const signature = Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", new Uint8Array())]));
}

test.beforeAll(async () => {
  if (!existsSync(join(defaultConfig.webDirectory, "index.html"))) {
    throw new Error(`No built web client in ${defaultConfig.webDirectory}: run pnpm build first.`);
  }
  dir = await mkdtemp(join(tmpdir(), "positrontanks-web-smoke-"));
  const quiet = { info: () => undefined, error: () => undefined };
  server = await startServer(
    { ...defaultConfig, port: 0, databasePath: ":memory:", storage: { kind: "local", directory: join(dir, "objects") } },
    { logger: quiet },
  );

  // Ada and Bob each enter a Bot in a short unthrottled duel, which then plays to the end.
  const ada = await player("ada");
  const bob = await player("bob");
  const uploaded = await fetch(`${server.url}/players/me/emblem`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ada}`, "content-type": "image/png" },
    body: redPng(32),
  });
  if (!uploaded.ok) throw new Error(`PUT /players/me/emblem: ${String(uploaded.status)} ${await uploaded.text()}`);
  const duel: unknown = JSON.parse(await readFile(new URL("../../ruleset-data/maps/duel.json", import.meta.url), "utf8"));
  const mapId = await created(ada, "/maps", { name: "Duel", map: duel });
  const design = (token: string) => created(token, "/bot-designs", { name: "Weaver", rulesetVersion: "r1", build: BUILD, program: PROGRAM });
  const adaDesign = await design(ada);
  const bobDesign = await design(bob);
  gameId = await created(ada, "/games", {
    rulesetVersion: "r1",
    mapId,
    playerCount: 2,
    pointBudget: 100,
    timeLimitSeconds: 10,
    pace: "unthrottled",
    fillTimeoutSeconds: 600,
  });
  await call("POST", `/games/${gameId}/entries`, { bots: [{ designId: adaDesign, name: "Ada" }] }, ada);
  await call("POST", `/games/${gameId}/entries`, { bots: [{ designId: bobDesign, name: "Bix" }] }, bob);
  await expect
    .poll(async () => (await call<{ state: string }>("GET", `/games/${gameId}`, undefined, ada)).state, { timeout: 30_000 })
    .toBe("finished");
});

test.afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("a Player logs in, opens a Finished Game's Replay and reaches Game Over", async ({ page }) => {
  // Signed out, the Game page sends the Player to log in, then back.
  await page.goto(`${server.url}/play/games/${gameId}`);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByRole("heading", { name: /Duel/ })).toContainText("Finished");
  await page.getByRole("link", { name: "Watch the Replay" }).click();

  await page.getByRole("button", { name: "Skip to result" }).click();
  const gameOver = page.getByRole("region", { name: "Game Over" });
  await expect(gameOver).toBeVisible();
  await expect(gameOver).toContainText("ada");
  await expect(gameOver).toContainText("bob");
  // Ada's Emblem is her image, drawn on a canvas; Bob has none, so his is the initials disc.
  const adaEmblem = gameOver.locator('canvas[aria-label="ada\'s Emblem"]');
  await expect(adaEmblem).toBeVisible();
  // The e2e project has no DOM types: just what is read of the canvas.
  type Canvas2d = {
    width: number;
    height: number;
    getContext(kind: "2d"): { getImageData(x: number, y: number, w: number, h: number): { data: Iterable<number> } } | null;
  };
  const middle = await adaEmblem.evaluate((element) => {
    const canvas = element as unknown as Canvas2d;
    return [...(canvas.getContext("2d")?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data ?? [])];
  });
  expect(middle).toEqual([255, 0, 0, 255]);
  await expect(gameOver.locator('svg[aria-label="bob\'s Emblem"]')).toContainText("B");
  await expect(gameOver.getByRole("button", { name: "Watch again" })).toBeVisible();
});

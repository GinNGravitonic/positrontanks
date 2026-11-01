/**
 * The web client's smoke test (docs/spec/frontend.md section 9): against a
 * local server serving the built client, a Player logs in, opens a Finished
 * Game's Replay and reaches Game Over.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  await expect(gameOver.getByRole("button", { name: "Watch again" })).toBeVisible();
});

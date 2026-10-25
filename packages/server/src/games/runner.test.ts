import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameRecord, replayGame, replayOf, type GameRecord as EngineGameRecord } from "@aumohta/engine-r1";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { LocalObjectStore } from "../storage/local-object-store.js";
import type { ObjectStore } from "../storage/object-store.js";
import { gameRecordKey, replayKey, type Pacing } from "./runner.js";

const r1 = loadRuleset("r1");
const DUEL: unknown = JSON.parse(
  readFileSync(new URL("../../../ruleset-data/maps/duel.json", import.meta.url), "utf8"),
);
const quiet: Logger = { info: () => undefined, error: () => undefined };

const noArmor = { front: null, left: null, right: null, rear: null };
/** Scout + pellet gun + wheels = 64 points. */
const BUILD = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
/** Charges forward, weaving at random (each Bot draws from its own seeded stream), firing straight ahead. */
const PROGRAM = `function tick() { throttle(1); turn(random() * 0.2 - 0.1); fire("gun", 0); } // secret-sauce`;

let dir: string;
let objects: LocalObjectStore;
/** Every server started by a test, closed afterwards. */
const servers: RunningServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aumohta-runner-"));
  objects = new LocalObjectStore(join(dir, "objects"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A server on this test's database file and object directory, so a later one sees what an earlier one left. */
async function boot(
  options: { pacing?: Pacing; maxUnthrottled?: number; objects?: ObjectStore } = {},
): Promise<RunningServer> {
  const config: ServerConfig = {
    ...defaultConfig,
    port: 0,
    databasePath: join(dir, "aumohta.db"),
    storage: { kind: "local", directory: join(dir, "objects") },
    limits: { ...defaultConfig.limits, maxConcurrentUnthrottledGames: options.maxUnthrottled ?? 2 },
  };
  const running = await startServer(config, {
    logger: quiet,
    objects: options.objects ?? objects,
    pacing: options.pacing ?? { sleep: nextTurn },
  });
  servers.push(running);
  return running;
}

/** Keeps realtime Pace without waiting, still letting other work run between Ticks. */
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function call(
  server: RunningServer,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(server.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function player(server: RunningServer, username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call(server, "POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call(server, "POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

async function created(server: RunningServer, token: string, path: string, body: unknown): Promise<string> {
  const response = await call(server, "POST", path, { token, body });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

interface Game {
  id: string;
  state: string;
  endedAt: string | null;
  result: {
    tick: number;
    end: string;
    winner: { id: string; username: string } | null;
    decidedBy: string | null;
  } | null;
}

/** Alice and Bob, each with a Bot Design, and a duel Map. */
async function setUp(server: RunningServer) {
  const alice = await player(server, "alice");
  const bob = await player(server, "bob");
  const design = (token: string) =>
    created(server, token, "/bot-designs", { name: "Weaver", rulesetVersion: "r1", build: BUILD, program: PROGRAM });
  return {
    alice,
    bob,
    aliceDesign: await design(alice),
    bobDesign: await design(bob),
    mapId: await created(server, alice, "/maps", { name: "Duel", map: DUEL }),
  };
}

type Players = Awaited<ReturnType<typeof setUp>>;

/** Creates a Game and fills it with one Bot each from Alice and Bob, which starts it. */
async function playGame(server: RunningServer, p: Players, pace: string, timeLimitSeconds = 60): Promise<string> {
  const id = await created(server, p.alice, "/games", {
    rulesetVersion: "r1",
    mapId: p.mapId,
    playerCount: 2,
    pointBudget: 100,
    timeLimitSeconds,
    pace,
    fillTimeoutSeconds: 600,
  });
  for (const [token, designId, name] of [
    [p.alice, p.aliceDesign, "Ada"],
    [p.bob, p.bobDesign, "Bix"],
  ] as const) {
    expect((await call(server, "POST", `/games/${id}/entries`, { token, body: { bots: [{ designId, name }] } })).status).toBe(201);
  }
  return id;
}

async function getGame(server: RunningServer, token: string, id: string): Promise<Game> {
  const response = await call(server, "GET", `/games/${id}`, { token });
  expect(response.status).toBe(200);
  return response.body as Game;
}

async function readJson(key: string): Promise<unknown> {
  const data = await objects.get(key);
  if (data === undefined) throw new Error(`no object at ${key}`);
  return JSON.parse(new TextDecoder().decode(data));
}

describe("the Game runner", () => {
  it("resumes a Game interrupted mid-way to the identical outcome", async () => {
    // The first server freezes after Tick 25, as if killed: it never plays,
    // saves or stores anything again.
    const FROZEN_AT = 25;
    let reached = (): void => undefined;
    const frozen = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let ticks = 0;
    const first = await boot({
      pacing: {
        sleep: () => {
          if (++ticks < FROZEN_AT) return nextTurn();
          reached();
          return new Promise<void>(() => undefined);
        },
      },
    });
    const p = await setUp(first);
    const id = await playGame(first, p, "realtime");
    await frozen;

    const stopped = first.services.db.games.getGame(id);
    expect(stopped).toMatchObject({ state: "running", lastTick: FROZEN_AT, result: null });
    const startRecord = (await readJson(gameRecordKey(id))) as EngineGameRecord;
    expect(startRecord).toMatchObject({ tick: 0, result: null });
    expect(await objects.exists(replayKey(id))).toBe(false);

    // A new server on the same database and objects resumes the Game at
    // startup: it replays the Game Record to Tick 25 at once and plays on.
    let resumedTicks = 0;
    const second = await boot({
      pacing: {
        sleep: () => {
          resumedTicks++;
          return nextTurn();
        },
      },
    });
    await second.services.runner.idle();

    const game = await getGame(second, p.bob, id);
    expect(game.state).toBe("finished");
    expect(game.endedAt).not.toBeNull();
    const result = game.result;
    if (result === null) throw new Error("a Finished Game has a result");
    expect(result.tick).toBeGreaterThan(FROZEN_AT);
    // Realtime Pace waits after every Tick but the last, and only for Ticks played after the resume.
    expect(resumedTicks).toBe(result.tick - FROZEN_AT - 1);

    // The stored Game Record is the one the Game started from, now complete.
    const record = (await readJson(gameRecordKey(id))) as EngineGameRecord;
    expect(record.seed).toBe(startRecord.seed);
    expect(record.startingPositions).toEqual(startRecord.startingPositions);
    expect(record.entries).toEqual(startRecord.entries);
    expect(record.tick).toBe(result.tick);

    // Identical outcome: the same Game Record played straight through, with
    // no interruption, gives the same result and the same Replay, Tick for Tick.
    const uninterrupted = replayGame(startRecord, r1);
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    expect(record).toEqual(plain(gameRecord(uninterrupted)));
    const replay = await readJson(replayKey(id));
    expect(replay).toEqual(plain(replayOf(uninterrupted)));

    // The result as the API shows it.
    const engineResult = uninterrupted.result;
    if (engineResult === null) throw new Error("the uninterrupted Game ended");
    const ids: Record<string, string> = {};
    for (const entry of record.entries) ids[entry.player] = entry.bots[0]?.name === "Ada" ? "alice" : "bob";
    expect(result.winner === null ? null : result.winner.username).toBe(
      engineResult.winner === null ? null : ids[engineResult.winner],
    );
    expect(result.tick).toBe(engineResult.tick);

    // The Replay holds the Builds, never a Program; the Game Record keeps them.
    expect(JSON.stringify(replay)).not.toContain("secret-sauce");
    expect(JSON.stringify(record)).toContain("secret-sauce");
  });

  it("plays unthrottled Games no more than the limit at once, in the order they started", async () => {
    // With a limit of 0, unthrottled Games wait; realtime Games are not limited.
    const first = await boot({ maxUnthrottled: 0 });
    const p = await setUp(first);
    const one = await playGame(first, p, "unthrottled", 20);
    const two = await playGame(first, p, "unthrottled", 20);
    const live = await playGame(first, p, "realtime", 5);
    await first.services.runner.idle();
    expect((await getGame(first, p.alice, live)).state).toBe("finished");
    for (const id of [one, two]) {
      expect(first.services.db.games.getGame(id)).toMatchObject({ state: "running", lastTick: null });
      expect(await objects.exists(gameRecordKey(id))).toBe(false);
    }
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    // After a restart with a limit of 1, the waiting Games are played one after the other.
    const writes: string[] = [];
    const watched: ObjectStore = {
      put: (key, body) => {
        writes.push(key);
        return objects.put(key, body);
      },
      get: (key) => objects.get(key),
      exists: (key) => objects.exists(key),
      delete: (key) => objects.delete(key),
      list: (prefix) => objects.list(prefix),
    };
    const second = await boot({ maxUnthrottled: 1, objects: watched });
    await second.services.runner.idle();
    for (const id of [one, two]) {
      const game = await getGame(second, p.bob, id);
      expect(game.state).toBe("finished");
      expect(game.result?.tick).toBeGreaterThan(0);
    }
    expect(writes).toEqual([
      gameRecordKey(one),
      gameRecordKey(one),
      replayKey(one),
      gameRecordKey(two),
      gameRecordKey(two),
      replayKey(two),
    ]);
  });

  it("shows a Finished Game's result in the API", async () => {
    const server = await boot();
    const p = await setUp(server);
    const id = await playGame(server, p, "unthrottled", 1);
    await server.services.runner.idle();
    const game = await getGame(server, p.alice, id);
    expect(game).toMatchObject({ state: "finished", result: { tick: expect.any(Number) as number } });
    const result = game.result;
    if (result === null) throw new Error("a Finished Game has a result");
    expect(["last_standing", "none_standing", "time_limit"]).toContain(result.end);
    if (result.winner === null) expect(result.decidedBy).toBeNull();
    else expect(["alice", "bob"]).toContain(result.winner.username);
    // Open and Running Games have none.
    const open = await created(server, p.alice, "/games", {
      rulesetVersion: "r1",
      mapId: p.mapId,
      playerCount: 2,
      pointBudget: 100,
      timeLimitSeconds: 1,
      pace: "realtime",
      fillTimeoutSeconds: 600,
    });
    expect((await getGame(server, p.alice, open)).result).toBeNull();
  });
});

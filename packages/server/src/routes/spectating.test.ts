import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay, ReplayTick } from "@aumohta/engine-r1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { programLogsKey, replayKey, type Pacing } from "../games/runner.js";
import { LocalObjectStore } from "../storage/local-object-store.js";
import type { ObjectStore } from "../storage/object-store.js";

const DUEL: unknown = JSON.parse(
  readFileSync(new URL("../../../ruleset-data/maps/duel.json", import.meta.url), "utf8"),
);
const quiet: Logger = { info: () => undefined, error: () => undefined };

const noArmor = { front: null, left: null, right: null, rear: null };
/** Scout + pellet gun + wheels = 64 points. */
const BUILD = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
/** Charges forward, weaving at random, firing straight ahead, and logs each Tick. */
const PROGRAM = `function tick() { throttle(1); turn(random() * 0.2 - 0.1); fire("gun", 0); log(self.tick); } // secret-sauce`;
const SECRET = "secret-sauce";

let dir: string;
let objects: LocalObjectStore;
const servers: RunningServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aumohta-spectating-"));
  objects = new LocalObjectStore(join(dir, "objects"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(options: { pacing?: Pacing; maxUnthrottled?: number; objects?: ObjectStore } = {}): Promise<RunningServer> {
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

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** A promise with its resolve function. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Realtime pacing that holds the Game after Tick `at` until released. */
function holdAt(at: number): { pacing: Pacing; reached: Promise<void>; release: () => void } {
  const reached = signal();
  const released = signal();
  let ticks = 0;
  return {
    pacing: {
      sleep: () => {
        if (++ticks !== at) return nextTurn();
        reached.resolve();
        return released.promise;
      },
    },
    reached: reached.promise,
    release: released.resolve,
  };
}

interface Response {
  status: number;
  text: string;
  body: unknown;
}

async function call(server: RunningServer, method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(server.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) };
}

const codeOf = (response: Response): string => (response.body as { error: { code: string } }).error.code;

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

/** Alice and Bob, each with a Bot Design, Carol with none, and a duel Map. */
async function setUp(server: RunningServer) {
  const alice = await player(server, "alice");
  const bob = await player(server, "bob");
  const carol = await player(server, "carol");
  const design = (token: string) =>
    created(server, token, "/bot-designs", { name: "Weaver", rulesetVersion: "r1", build: BUILD, program: PROGRAM });
  return {
    alice,
    bob,
    carol,
    aliceDesign: await design(alice),
    bobDesign: await design(bob),
    mapId: await created(server, alice, "/maps", { name: "Duel", map: DUEL }),
  };
}

type Players = Awaited<ReturnType<typeof setUp>>;

function openGame(server: RunningServer, p: Players, pace: string, timeLimitSeconds = 60): Promise<string> {
  return created(server, p.alice, "/games", {
    rulesetVersion: "r1",
    mapId: p.mapId,
    playerCount: 2,
    pointBudget: 100,
    timeLimitSeconds,
    pace,
    fillTimeoutSeconds: 600,
  });
}

async function enter(server: RunningServer, token: string, id: string, designId: string, name: string): Promise<void> {
  expect((await call(server, "POST", `/games/${id}/entries`, { token, body: { bots: [{ designId, name }] } })).status).toBe(201);
}

/** Creates a Game and fills it with Alice's Ada and Bob's Bix, which starts it. */
async function playGame(server: RunningServer, p: Players, pace: string, timeLimitSeconds = 60): Promise<string> {
  const id = await openGame(server, p, pace, timeLimitSeconds);
  await enter(server, p.alice, id, p.aliceDesign, "Ada");
  await enter(server, p.bob, id, p.bobDesign, "Bix");
  return id;
}

async function storedReplay(id: string): Promise<Replay> {
  const data = await objects.get(replayKey(id));
  if (data === undefined) throw new Error(`no Replay for ${id}`);
  return JSON.parse(new TextDecoder().decode(data)) as Replay;
}

interface Game {
  id: string;
  state: string;
  entries: { player: { id: string; username: string }; bots: { name: string; build?: unknown }[] }[];
  result: { tick: number } | null;
}

interface Snapshot {
  game: Game;
  replay: Replay;
}

interface Event {
  event: string;
  id: string | undefined;
  data: unknown;
}

interface Stream {
  status: number;
  contentType: string | null;
  events: AsyncGenerator<Event>;
  /** Everything received so far, comments included. */
  raw: () => string;
}

/** Opens the event stream; `events` yields each event as it arrives and returns when the server ends the stream. */
async function stream(server: RunningServer, token: string, id: string): Promise<Stream> {
  const response = await fetch(`${server.url}/games/${id}/stream`, { headers: { authorization: `Bearer ${token}` } });
  let raw = "";
  async function* events(): AsyncGenerator<Event> {
    if (response.body === null) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      raw += value;
      buffer += value;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const fields: Record<string, string> = {};
        for (const line of buffer.slice(0, end).split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(": ");
          fields[line.slice(0, colon)] = line.slice(colon + 2);
        }
        buffer = buffer.slice(end + 2);
        if (fields.event !== undefined) {
          yield { event: fields.event, id: fields.id, data: JSON.parse(fields.data ?? "null") };
        }
      }
    }
  }
  return { status: response.status, contentType: response.headers.get("content-type"), events: events(), raw: () => raw };
}

async function next(events: AsyncGenerator<Event>): Promise<Event> {
  const result = await events.next();
  if (result.done === true) throw new Error("the stream ended");
  return result.value;
}

async function rest(events: AsyncGenerator<Event>): Promise<Event[]> {
  const all: Event[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("the event stream", () => {
  it("delivers a snapshot, then every Tick of a live Game, then its end", async () => {
    const hold = holdAt(5);
    const server = await boot({ pacing: hold.pacing });
    const p = await setUp(server);
    const id = await playGame(server, p, "realtime");
    await hold.reached;

    // Carol, a Spectator, joins mid-Game: the snapshot is the latest Tick, with every Build.
    const watching = await stream(server, p.carol, id);
    expect(watching.status).toBe(200);
    expect(watching.contentType).toBe("text/event-stream; charset=utf-8");
    const first = await next(watching.events);
    expect(first).toMatchObject({ event: "snapshot", id: "5" });
    const snapshot = first.data as Snapshot;
    expect(snapshot.game.state).toBe("running");
    expect(snapshot.replay.ticks.map((t) => t.tick)).toEqual([5]);
    expect(snapshot.replay.entries.map((e) => e.bots.map((b) => [b.name, b.build]))).toEqual([
      [["Ada", BUILD]],
      [["Bix", BUILD]],
    ]);

    hold.release();
    const events = await rest(watching.events);
    const end = events.pop();
    expect(end?.event).toBe("end");
    const finished = (end?.data as { game: Game }).game;
    expect(finished.state).toBe("finished");
    const lastTick = finished.result?.tick ?? 0;
    expect(lastTick).toBeGreaterThan(5);

    // Every Tick after the snapshot, in order, exactly as the Replay has them.
    expect(events.every((e) => e.event === "tick")).toBe(true);
    const ticks = events.map((e) => e.data as ReplayTick);
    expect(ticks.map((t) => t.tick)).toEqual(Array.from({ length: lastTick - 5 }, (_, i) => i + 6));
    expect(events.map((e) => e.id)).toEqual(ticks.map((t) => String(t.tick)));
    const replay = await storedReplay(id);
    expect(snapshot.replay.ticks[0]).toEqual(replay.ticks[5]);
    expect(ticks).toEqual(replay.ticks.slice(6));
    const header = (r: Replay) => ({ ruleset: r.ruleset, tickRate: r.tickRate, map: r.map, timeLimitTicks: r.timeLimitTicks, entries: r.entries });
    expect(header(snapshot.replay)).toEqual(header(replay));

    expect(watching.raw()).not.toContain(SECRET);
  });

  it("waits for a Game the runner has not started, then delivers it from Tick 0 (unthrottled)", async () => {
    // The runner reads the Game Record before starting a Game; hold it there.
    const release = signal();
    const held: ObjectStore = {
      put: (key, body) => objects.put(key, body),
      get: async (key) => {
        await release.promise;
        return objects.get(key);
      },
      exists: (key) => objects.exists(key),
      delete: (key) => objects.delete(key),
      list: (prefix) => objects.list(prefix),
    };
    const server = await boot({ objects: held });
    const p = await setUp(server);
    const id = await playGame(server, p, "unthrottled", 3);

    // Running but not yet played: no snapshot yet, but the stream waits.
    const snapshot = await call(server, "GET", `/games/${id}/snapshot`, { token: p.carol });
    expect(snapshot.status).toBe(409);
    expect(codeOf(snapshot)).toBe("game_not_started");
    const watching = await stream(server, p.carol, id);
    expect(watching.status).toBe(200);
    release.resolve();

    const [first, ...events] = await rest(watching.events);
    expect(first?.event).toBe("snapshot");
    expect((first?.data as Snapshot).replay.ticks.map((t) => t.tick)).toEqual([0]);
    const end = events.pop();
    expect(end?.event).toBe("end");
    const lastTick = (end?.data as { game: Game }).game.result?.tick ?? 0;
    expect(events.map((e) => (e.data as ReplayTick).tick)).toEqual(Array.from({ length: lastTick }, (_, i) => i + 1));
    expect(events.map((e) => e.data)).toEqual((await storedReplay(id)).ticks.slice(1));
  });

  it("gives a Finished Game's last snapshot and end at once", async () => {
    const server = await boot();
    const p = await setUp(server);
    const id = await playGame(server, p, "unthrottled", 2);
    await server.services.runner.idle();
    const replay = await storedReplay(id);

    const events = await rest((await stream(server, p.carol, id)).events);
    expect(events.map((e) => e.event)).toEqual(["snapshot", "end"]);
    expect((events[0]?.data as Snapshot).replay.ticks).toEqual(replay.ticks.slice(-1));
    expect((events[1]?.data as { game: Game }).game.state).toBe("finished");
  });

  it("ends open streams when the server shuts down", async () => {
    // With no unthrottled slot, the Game stays Running and unplayed.
    const server = await boot({ maxUnthrottled: 0 });
    const p = await setUp(server);
    const id = await playGame(server, p, "unthrottled");
    const watching = await stream(server, p.carol, id);
    expect(watching.status).toBe(200);
    const ended = rest(watching.events);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(await ended).toEqual([]);
  });

  it("refuses Open and Cancelled Games, and needs a credential", async () => {
    const server = await boot();
    const p = await setUp(server);
    const open = await openGame(server, p, "realtime");
    const cancelled = await openGame(server, p, "realtime");
    expect((await call(server, "POST", `/games/${cancelled}/cancel`, { token: p.alice })).status).toBe(200);

    for (const path of ["stream", "snapshot"]) {
      const notStarted = await call(server, "GET", `/games/${open}/${path}`, { token: p.bob });
      expect(notStarted.status).toBe(409);
      expect(codeOf(notStarted)).toBe("game_not_started");
      expect(codeOf(await call(server, "GET", `/games/${cancelled}/${path}`, { token: p.bob }))).toBe("game_cancelled");
      expect((await call(server, "GET", `/games/nope/${path}`, { token: p.bob })).status).toBe(404);
      expect((await call(server, "GET", `/games/${open}/${path}`)).status).toBe(401);
    }
  });
});

describe("snapshots and Replays", () => {
  it("shows the latest Tick of a Running Game, and the Replay once it is Finished", async () => {
    const hold = holdAt(5);
    const server = await boot({ pacing: hold.pacing });
    const p = await setUp(server);
    const id = await playGame(server, p, "realtime", 3);
    await hold.reached;

    const live = await call(server, "GET", `/games/${id}/snapshot`, { token: p.carol });
    expect(live.status).toBe(200);
    expect((live.body as Snapshot).replay.ticks.map((t) => t.tick)).toEqual([5]);
    expect((live.body as Snapshot).replay.result).toBeNull();
    const early = await call(server, "GET", `/games/${id}/replay`, { token: p.carol });
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe("game_not_finished");

    hold.release();
    await server.services.runner.idle();
    const replay = await storedReplay(id);
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

    const full = await call(server, "GET", `/games/${id}/replay`, { token: p.carol });
    expect(full.status).toBe(200);
    const body = full.body as Snapshot;
    expect(body.replay).toEqual(plain(replay));
    expect(body.game.state).toBe("finished");
    expect(body.game.entries.map((e) => e.bots.map((b) => b.build))).toEqual([[BUILD], [BUILD]]);

    const final = await call(server, "GET", `/games/${id}/snapshot`, { token: p.carol });
    expect((final.body as Snapshot).replay.ticks).toEqual(plain(replay.ticks.slice(-1)));
    expect((final.body as Snapshot).replay.result).toEqual(plain(replay.result));

    for (const response of [live, full, final]) expect(response.text).not.toContain(SECRET);
  });

  it("has no Replay for Open or Cancelled Games", async () => {
    const server = await boot();
    const p = await setUp(server);
    const open = await openGame(server, p, "realtime");
    const cancelled = await openGame(server, p, "realtime");
    expect((await call(server, "POST", `/games/${cancelled}/cancel`, { token: p.alice })).status).toBe(200);
    expect(codeOf(await call(server, "GET", `/games/${open}/replay`, { token: p.bob }))).toBe("game_not_finished");
    expect(codeOf(await call(server, "GET", `/games/${cancelled}/replay`, { token: p.bob }))).toBe("game_cancelled");
  });
});

describe("Program logs", () => {
  interface Logs {
    bots: { bot: number; name: string; runs: { tick: number; result: { outcome: string; log: string[] } }[] }[];
  }
  const logsOf = (response: Response): Logs => response.body as Logs;

  it("shows each Player only their own Bots' logs, live and after the Game", async () => {
    const hold = holdAt(5);
    const server = await boot({ pacing: hold.pacing });
    const p = await setUp(server);
    const id = await playGame(server, p, "realtime", 3);
    await hold.reached;

    const alice = await call(server, "GET", `/games/${id}/program-logs`, { token: p.alice });
    expect(alice.status).toBe(200);
    expect(logsOf(alice).bots.map((b) => [b.bot, b.name])).toEqual([[1, "Ada"]]);
    const runs = logsOf(alice).bots[0]?.runs ?? [];
    expect(runs.at(-1)?.tick).toBe(5);
    expect(runs.find((r) => r.tick === 3)?.result).toMatchObject({ outcome: "completed", log: ["3"] });

    const bob = await call(server, "GET", `/games/${id}/program-logs?fromTick=2&toTick=3`, { token: p.bob });
    expect(logsOf(bob).bots.map((b) => [b.bot, b.name, b.runs.map((r) => r.tick)])).toEqual([[2, "Bix", [2, 3]]]);

    // Carol has no Bots in the Game.
    expect((await call(server, "GET", `/games/${id}/program-logs`, { token: p.carol })).status).toBe(404);
    expect((await call(server, "GET", `/games/${id}/program-logs?fromTick=x`, { token: p.alice })).status).toBe(400);

    hold.release();
    await server.services.runner.idle();
    const after = await call(server, "GET", `/games/${id}/program-logs`, { token: p.alice });
    expect(after.status).toBe(200);
    const game = (await call(server, "GET", `/games/${id}`, { token: p.alice })).body as Game;
    expect(logsOf(after).bots.map((b) => [b.name, b.runs.at(-1)?.tick])).toEqual([["Ada", game.result?.tick]]);
    // Stored per Player, so a Player's file holds only their own Bots.
    const [aliceId, bobId] = game.entries.map((e) => e.player.id);
    for (const [playerId, name] of [
      [aliceId, "Ada"],
      [bobId, "Bix"],
    ] as const) {
      const stored = await objects.get(programLogsKey(id, playerId ?? ""));
      const logs = JSON.parse(new TextDecoder().decode(stored)) as { name: string }[];
      expect(logs.map((l) => l.name)).toEqual([name]);
    }
    for (const response of [alice, bob, after]) expect(response.text).not.toContain(SECRET);
  });

  it("has nothing before a Game starts", async () => {
    const server = await boot();
    const p = await setUp(server);
    const id = await openGame(server, p, "realtime");
    await enter(server, p.alice, id, p.aliceDesign, "Ada");
    const response = await call(server, "GET", `/games/${id}/program-logs`, { token: p.alice });
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe("game_not_started");
    expect((await call(server, "GET", `/games/${id}/program-logs`, { token: p.bob })).status).toBe(404);
  });
});

describe("the OpenAPI document", () => {
  it("describes the spectating endpoints", async () => {
    const server = await boot();
    const document = (await call(server, "GET", "/openapi.json")).body as { paths: Record<string, Record<string, unknown>> };
    for (const path of ["snapshot", "stream", "replay", "program-logs"]) {
      expect(Object.keys(document.paths[`/games/{gameId}/${path}`] ?? {})).toEqual(["get"]);
    }
  });
});

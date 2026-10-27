import { readFileSync } from "node:fs";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { engineR1Ruleset, RulesetCatalog } from "../rulesets/catalog.js";

const config: ServerConfig = {
  ...defaultConfig,
  port: 0,
  databasePath: ":memory:",
  // No unthrottled Game is played, so the Games filled here stay Running (runner.test.ts plays them).
  limits: { ...defaultConfig.limits, maxTimeLimitSeconds: 300, maxFillTimeoutSeconds: 3600, maxConcurrentUnthrottledGames: 0 },
};
const quiet: Logger = { info: () => undefined, error: () => undefined };

const r1 = loadRuleset("r1");
/** A second Ruleset version that supports only a (non-existent) Map Format 2. */
const r1x = engineR1Ruleset({ ...r1, version: "r1x", mapFormats: [2] });

type MapContent = Record<string, unknown> & { spawnZones: { capacity: number }[] };
const sample = (name: string): MapContent =>
  JSON.parse(readFileSync(new URL(`../../../ruleset-data/maps/${name}.json`, import.meta.url), "utf8")) as MapContent;

/** Two Spawn Zones of capacity 4. */
const DUEL = sample("duel");
/** Four Spawn Zones, capacities 3, 3, 3, 2. */
const FOUR_CORNERS = sample("four-corners");

const START = new Date("2026-03-01T12:00:00.000Z");
let now: Date;
let running: RunningServer;

beforeEach(async () => {
  now = START;
  running = await startServer(config, {
    logger: quiet,
    rulesets: new RulesetCatalog([engineR1Ruleset(r1), r1x]),
    clock: () => now,
  });
});

afterEach(async () => {
  await running.close();
});

const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

interface Response {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(running.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface Detail {
  path: string;
  message: string;
}

const errorOf = (response: Response): { code: string; message: string; details?: Detail[] } =>
  (response.body as { error: { code: string; message: string; details?: Detail[] } }).error;

const paths = (response: Response): string[] => (errorOf(response).details ?? []).map((d) => d.path);

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

const noArmor = { front: null, left: null, right: null, rear: null };
/** Scout + pellet gun + wheels = 64 points. */
const CHEAP_BUILD = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
/** Scout + pellet gun + wheels + light front plate = 69 points. */
const PLATED_BUILD = { ...CHEAP_BUILD, armor: { ...noArmor, front: "lightPlate" } };
const PROGRAM = `function tick() { throttle(1); fire("gun", 0); }`;
const SECRET_PROGRAM = `function tick() { throttle(1); fire("gun", 0); } // secret-sauce`;

async function design(
  token: string,
  fields: { rulesetVersion?: string; build?: unknown; program?: string } = {},
): Promise<string> {
  const response = await call("POST", "/bot-designs", {
    token,
    body: { name: "Scout", rulesetVersion: "r1", build: CHEAP_BUILD, program: PROGRAM, ...fields },
  });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

async function createMap(token: string, map: unknown = DUEL): Promise<string> {
  const response = await call("POST", "/maps", { token, body: { name: "Arena", map } });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

interface EntryBot {
  name: string;
  design?: { designId: string; revision: number };
  cost?: number;
  build?: unknown;
}

interface Entry {
  id: string;
  player: { id: string; username: string };
  createdAt: string;
  cost?: number;
  bots: EntryBot[];
}

interface Game {
  id: string;
  state: string;
  initiator: { id: string; username: string };
  rulesetVersion: string;
  map: { id: string; name: string; revision: number };
  playerCount: number;
  pointBudget: number;
  timeLimitSeconds: number;
  pace: string;
  fillTimeoutSeconds: number;
  createdAt: string;
  fillDeadline: string;
  startedAt: string | null;
  endedAt: string | null;
  cancelReason: string | null;
  entryCount: number;
  entries: Entry[];
}

const gameBody = (mapId: string, fields: Record<string, unknown> = {}) => ({
  rulesetVersion: "r1",
  mapId,
  playerCount: 2,
  pointBudget: 100,
  timeLimitSeconds: 120,
  pace: "unthrottled",
  fillTimeoutSeconds: 600,
  ...fields,
});

async function createGame(token: string, mapId: string, fields: Record<string, unknown> = {}): Promise<Game> {
  const response = await call("POST", "/games", { token, body: gameBody(mapId, fields) });
  expect(response.status).toBe(201);
  return response.body as Game;
}

const submit = (token: string, gameId: string, bots: unknown) =>
  call("POST", `/games/${gameId}/entries`, { token, body: { bots } });

async function enter(token: string, gameId: string, bots: unknown): Promise<{ entry: Entry; game: Game }> {
  const response = await submit(token, gameId, bots);
  expect(response.status).toBe(201);
  return response.body as { entry: Entry; game: Game };
}

async function getGame(token: string, gameId: string): Promise<Game> {
  const response = await call("GET", `/games/${gameId}`, { token });
  expect(response.status).toBe(200);
  return response.body as Game;
}

async function browse(token: string, query = ""): Promise<Game[]> {
  const response = await call("GET", `/games${query}`, { token });
  expect(response.status).toBe(200);
  return (response.body as { games: Game[] }).games;
}

let alice: string;
let bob: string;
let carol: string;
let mapId: string;

beforeEach(async () => {
  alice = await player("alice");
  bob = await player("bob");
  carol = await player("carol");
  mapId = await createMap(alice);
});

describe("creating Games", () => {
  it("creates an Open Game on the latest Map Revision without the Initiator entering", async () => {
    const game = await createGame(bob, mapId, { pace: "realtime" });
    expect(game).toMatchObject({
      state: "open",
      initiator: { username: "bob" },
      rulesetVersion: "r1",
      map: { id: mapId, name: "Arena", revision: 1 },
      playerCount: 2,
      pointBudget: 100,
      timeLimitSeconds: 120,
      pace: "realtime",
      fillTimeoutSeconds: 600,
      createdAt: START.toISOString(),
      fillDeadline: "2026-03-01T12:10:00.000Z",
      startedAt: null,
      endedAt: null,
      cancelReason: null,
      entryCount: 0,
      entries: [],
    });
    expect(await getGame(carol, game.id)).toEqual(game);
  });

  it("uses an earlier Map Revision when asked", async () => {
    expect((await call("POST", `/maps/${mapId}/revisions`, { token: alice, body: { map: FOUR_CORNERS } })).status).toBe(201);
    const latest = await createGame(alice, mapId, { playerCount: 4 });
    expect(latest.map.revision).toBe(2);
    const earlier = await createGame(alice, mapId, { mapRevision: 1 });
    expect(earlier.map.revision).toBe(1);
    const missing = await call("POST", "/games", { token: alice, body: gameBody(mapId, { mapRevision: 3 }) });
    expect(paths(missing)).toEqual(["mapRevision"]);
  });

  it("states the resolved Map Revision wherever the Game appears when none was given", async () => {
    expect((await call("POST", `/maps/${mapId}/revisions`, { token: alice, body: { map: DUEL } })).status).toBe(201);
    const game = await createGame(bob, mapId);
    expect(game.map).toEqual({ id: mapId, name: "Arena", revision: 2 });
    expect((await getGame(carol, game.id)).map.revision).toBe(2);
    expect((await browse(carol)).map((g) => g.map.revision)).toEqual([2]);
    const mine = (await call("GET", "/players/me/games", { token: bob })).body as { games: Game[] };
    expect(mine.games.map((g) => g.map.revision)).toEqual([2]);

    // A later Revision does not move a Game already created.
    expect((await call("POST", `/maps/${mapId}/revisions`, { token: alice, body: { map: DUEL } })).status).toBe(201);
    expect((await getGame(bob, game.id)).map.revision).toBe(2);
  });

  it("reports every problem with the settings", async () => {
    const response = await call("POST", "/games", {
      token: alice,
      body: gameBody(mapId, {
        playerCount: 3,
        pointBudget: 99,
        timeLimitSeconds: 301,
        pace: "fast",
        fillTimeoutSeconds: 0,
      }),
    });
    expect(response.status).toBe(422);
    expect(errorOf(response).details).toEqual([
      { path: "playerCount", message: "must be an integer from 2 to 2 (the Map Revision's Spawn Zones)" },
      { path: "pointBudget", message: "must be an integer from 100 to 800 (Ruleset r1's Point Budget range)" },
      { path: "timeLimitSeconds", message: "must be an integer from 1 to 300" },
      { path: "pace", message: "must be one of realtime, unthrottled" },
      { path: "fillTimeoutSeconds", message: "must be an integer from 1 to 3600" },
    ]);

    const unknown = await call("POST", "/games", {
      token: alice,
      body: gameBody("nope", { rulesetVersion: "r9", pointBudget: 2.5 }),
    });
    expect(paths(unknown)).toEqual(["rulesetVersion", "mapId", "pointBudget"]);

    const extra = await call("POST", "/games", { token: alice, body: { ...gameBody(mapId), seed: 1, pace: undefined } });
    expect(errorOf(extra).details).toEqual([
      { path: "seed", message: "is not a known field" },
      { path: "pace", message: "is required" },
    ]);

    expect((await call("POST", "/games", { body: gameBody(mapId) })).status).toBe(401);
  });

  it("refuses archived Maps", async () => {
    expect((await call("DELETE", `/maps/${mapId}`, { token: alice })).status).toBe(204);
    const response = await call("POST", "/games", { token: alice, body: gameBody(mapId) });
    expect(errorOf(response).details).toEqual([
      { path: "mapId", message: "is an archived Map, which new Games cannot use" },
    ]);
  });

  it("checks the Map's Terrains and Map Format against the Ruleset", async () => {
    const lava = await createMap(alice, {
      ...DUEL,
      baseTerrain: "lava",
      terrainRegions: [{ terrain: "road", shape: "circle", x: 30, y: 20, radius: 3 }, { terrain: "tar", shape: "circle", x: 5, y: 5, radius: 1 }],
    });
    const terrains = await call("POST", "/games", { token: alice, body: gameBody(lava) });
    expect(terrains.status).toBe(422);
    expect(errorOf(terrains).details).toEqual([
      { path: "mapRevision", message: 'map.baseTerrain is the unknown Terrain "lava" under Ruleset r1' },
      { path: "mapRevision", message: 'map.terrainRegions[1].terrain is the unknown Terrain "tar" under Ruleset r1' },
    ]);

    const format = await call("POST", "/games", { token: alice, body: gameBody(mapId, { rulesetVersion: "r1x" }) });
    expect(errorOf(format).details).toEqual([
      { path: "mapRevision", message: "is in Map Format 1, which Ruleset r1x does not support (it supports 2)" },
    ]);
  });
});

describe("browsing Open Games", () => {
  it("lists only Open Games, filtered", async () => {
    const corners = await createMap(bob, FOUR_CORNERS);
    const small = await createGame(alice, mapId, { pointBudget: 100 });
    advance(1);
    const big = await createGame(bob, corners, { pointBudget: 500, playerCount: 3 });
    advance(1);
    const cancelled = await createGame(alice, mapId);
    expect((await call("POST", `/games/${cancelled.id}/cancel`, { token: alice })).status).toBe(200);

    const ids = (games: Game[]) => games.map((g) => g.id);
    const all = await browse(carol);
    expect(ids(all)).toEqual([big.id, small.id]);
    expect(all[0]).not.toHaveProperty("entries");
    expect(ids(await browse(carol, "?rulesetVersion=r1"))).toEqual([big.id, small.id]);
    expect(ids(await browse(carol, "?rulesetVersion=r1x"))).toEqual([]);
    expect(ids(await browse(carol, `?mapId=${mapId}`))).toEqual([small.id]);
    expect(ids(await browse(carol, "?playerCount=3"))).toEqual([big.id]);
    expect(ids(await browse(carol, "?minPointBudget=101"))).toEqual([big.id]);
    expect(ids(await browse(carol, "?maxPointBudget=100"))).toEqual([small.id]);
    expect(ids(await browse(carol, "?minPointBudget=100&maxPointBudget=499"))).toEqual([small.id]);
    expect((await call("GET", "/games?playerCount=two", { token: carol })).status).toBe(400);
    expect((await call("GET", "/games")).status).toBe(401);
  });
});

describe("Entries", () => {
  it("accepts Entries, hides Builds while Open, and starts the Game when it is full", async () => {
    const game = await createGame(alice, mapId, { pointBudget: 200 });
    const bobDesign = await design(bob, { program: SECRET_PROGRAM });
    const carolDesign = await design(carol, { build: PLATED_BUILD });

    const first = await enter(bob, game.id, [
      { designId: bobDesign, name: "Rex" },
      { designId: bobDesign, revision: 1, name: "Dino" },
    ]);
    expect(first.entry).toEqual({
      id: first.entry.id,
      player: { id: expect.any(String) as string, username: "bob" },
      createdAt: START.toISOString(),
      cost: 128,
      bots: [
        { name: "Rex", design: { designId: bobDesign, revision: 1 }, cost: 64, build: CHEAP_BUILD },
        { name: "Dino", design: { designId: bobDesign, revision: 1 }, cost: 64, build: CHEAP_BUILD },
      ],
    });
    expect(first.game).toMatchObject({ state: "open", entryCount: 1 });

    // Others see who entered and the Bot Names, but no Builds or costs.
    const seen = await getGame(carol, game.id);
    expect(seen.entries).toEqual([
      {
        id: first.entry.id,
        player: first.entry.player,
        createdAt: START.toISOString(),
        bots: [{ name: "Rex" }, { name: "Dino" }],
      },
    ]);

    advance(5);
    const second = await enter(carol, game.id, [{ designId: carolDesign, name: "Plato" }]);
    expect(second.game).toMatchObject({
      state: "running",
      entryCount: 2,
      startedAt: "2026-03-01T12:00:05.000Z",
      endedAt: null,
    });

    // From Running, everyone sees every Build, but only owners see design ids, and nobody sees a Program.
    const started = await getGame(alice, game.id);
    expect(started.state).toBe("running");
    expect(started.entries.map((e) => e.bots)).toEqual([
      [
        { name: "Rex", cost: 64, build: CHEAP_BUILD },
        { name: "Dino", cost: 64, build: CHEAP_BUILD },
      ],
      [{ name: "Plato", cost: 69, build: PLATED_BUILD }],
    ]);
    expect(started.entries.map((e) => e.cost)).toEqual([128, 69]);
    for (const token of [alice, bob, carol]) {
      expect(JSON.stringify(await getGame(token, game.id))).not.toContain("secret-sauce");
    }
    expect((await getGame(carol, game.id)).entries[1]?.bots[0]?.design).toEqual({ designId: carolDesign, revision: 1 });

    // A Running Game takes no more Entries and none can be withdrawn.
    const late = await submit(alice, game.id, [{ designId: await design(alice), name: "Late" }]);
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe("game_not_open");
    const withdraw = await call("DELETE", `/games/${game.id}/entries/${first.entry.id}`, { token: bob });
    expect(withdraw.status).toBe(409);
    expect(errorOf(withdraw).code).toBe("game_not_open");
    expect(await browse(alice)).toEqual([]);
  });

  it("states the resolved Bot Design Revision to the owner when none was given", async () => {
    const id = await design(bob);
    const revised = await call("POST", `/bot-designs/${id}/revisions`, {
      token: bob,
      body: { build: PLATED_BUILD, program: PROGRAM },
    });
    expect(revised.status).toBe(201);
    const game = await createGame(alice, mapId, { playerCount: 2, pointBudget: 200 });

    const { entry, game: after } = await enter(bob, game.id, [
      { designId: id, name: "Latest" },
      { designId: id, revision: 1, name: "First" },
    ]);
    const expected = [
      { name: "Latest", design: { designId: id, revision: 2 }, cost: 69, build: PLATED_BUILD },
      { name: "First", design: { designId: id, revision: 1 }, cost: 64, build: CHEAP_BUILD },
    ];
    expect(entry.bots).toEqual(expected);
    expect(after.entries[0]?.bots).toEqual(expected);
    expect((await getGame(bob, game.id)).entries[0]?.bots).toEqual(expected);

    // A later Revision does not move an Entry already submitted.
    await call("POST", `/bot-designs/${id}/revisions`, { token: bob, body: { build: CHEAP_BUILD, program: PROGRAM } });
    expect((await getGame(bob, game.id)).entries[0]?.bots[0]?.design).toEqual({ designId: id, revision: 2 });
  });

  it("lets a Player submit several Entries to one Game", async () => {
    const game = await createGame(alice, mapId);
    const mine = await design(bob);
    await enter(bob, game.id, [{ designId: mine, name: "One" }]);
    const second = await enter(bob, game.id, [{ designId: mine, name: "Two" }]);
    expect(second.game.state).toBe("running");
    expect(second.game.entries.map((e) => e.player.username)).toEqual(["bob", "bob"]);
  });

  it("never shows a Bot Design's description, even to its owner", async () => {
    const game = await createGame(alice, mapId);
    const secret = await design(bob);
    const described = await call("PATCH", `/bot-designs/${secret}`, { token: bob, body: { description: "bob-design-notes" } });
    expect(described.status).toBe(200);
    const responses: unknown[] = [];
    const open = await enter(bob, game.id, [{ designId: secret, name: "Rex" }]);
    responses.push(open, await getGame(bob, game.id), await getGame(carol, game.id), await browse(carol));
    const started = await enter(carol, game.id, [{ designId: await design(carol), name: "Plato" }]);
    expect(started.game.state).toBe("running");
    responses.push(started);
    for (const token of [alice, bob, carol]) {
      responses.push(await getGame(token, game.id), (await call("GET", "/players/me/games", { token })).body);
    }
    for (const body of responses) expect(JSON.stringify(body)).not.toContain("bob-design-notes");
  });

  it("never shows a Bot Design's Revision notes, even to its owner", async () => {
    const game = await createGame(alice, mapId);
    const secret = await design(bob);
    const revised = await call("POST", `/bot-designs/${secret}/revisions`, {
      token: bob,
      body: { build: CHEAP_BUILD, program: PROGRAM, notes: "bob-revision-notes" },
    });
    expect(revised.status).toBe(201);
    const responses: unknown[] = [];
    const open = await enter(bob, game.id, [{ designId: secret, name: "Rex" }]);
    responses.push(open, await getGame(bob, game.id), await getGame(carol, game.id), await browse(carol));
    const started = await enter(carol, game.id, [{ designId: await design(carol), name: "Plato" }]);
    expect(started.game.state).toBe("running");
    responses.push(started);
    for (const token of [alice, bob, carol]) {
      responses.push(await getGame(token, game.id), (await call("GET", "/players/me/games", { token })).body);
      responses.push((await call("GET", `/games/${game.id}/snapshot`, { token })).body);
    }
    for (const body of responses) expect(JSON.stringify(body)).not.toContain("bob-revision-notes");
  });

  it("reports every problem with an Entry", async () => {
    const game = await createGame(alice, mapId);
    const mine = await design(bob);
    const archived = await design(bob);
    expect((await call("DELETE", `/bot-designs/${archived}`, { token: bob })).status).toBe(204);
    const theirs = await design(carol);

    const response = await submit(bob, game.id, [
      { designId: mine, name: "Rex" },
      { designId: mine, name: " rex " },
      { designId: archived, name: "Archie" },
      { designId: theirs, name: "Thief" },
      { designId: mine, revision: 2, name: "Future" },
      { designId: mine, name: "" },
      { designId: 7, name: "x".repeat(33), colour: "red" },
    ]);
    expect(response.status).toBe(422);
    expect(errorOf(response).details).toEqual([
      { path: "bots[1].name", message: "is already used in this Entry" },
      { path: "bots[2].designId", message: "is an archived Bot Design, which new Entries cannot use" },
      { path: "bots[3].designId", message: "is not one of your Bot Designs" },
      { path: "bots[4].revision", message: "must be an integer from 1 to 1" },
      { path: "bots[5].name", message: "must be 1 to 32 characters, without control characters" },
      { path: "bots[6].colour", message: "is not a known field" },
      { path: "bots", message: "has 7 Bots, more than any Spawn Zone of this Map holds (at most 4)" },
      { path: "bots", message: "cost 192 points, more than this Game's Point Budget of 100" },
    ]);

    expect(paths(await submit(bob, game.id, []))).toEqual(["bots"]);
    expect(paths(await call("POST", `/games/${game.id}/entries`, { token: bob, body: {} }))).toEqual(["bots"]);
    expect((await submit(bob, "nope", [{ designId: mine, name: "Rex" }])).status).toBe(404);
    expect((await getGame(alice, game.id)).entryCount).toBe(0);
  });

  it("refuses Bot Designs from another Ruleset", async () => {
    const game = await createGame(alice, mapId);
    // r1x shares r1's Parts Catalog, so the same Build is valid there.
    const other = await design(bob, { rulesetVersion: "r1x" });
    const response = await submit(bob, game.id, [{ designId: other, name: "Rex" }]);
    expect(errorOf(response).details).toEqual([
      { path: "bots[0].designId", message: "is authored for Ruleset r1x, but this Game uses r1" },
    ]);
  });

  it("keeps Bot Names unique within the Game, ignoring case", async () => {
    const game = await createGame(alice, mapId, { playerCount: 2 });
    await enter(bob, game.id, [{ designId: await design(bob), name: "Rex" }]);
    const response = await submit(carol, game.id, [{ designId: await design(carol), name: "REX" }]);
    expect(response.status).toBe(422);
    expect(errorOf(response).details).toEqual([{ path: "bots[0].name", message: "is already taken in this Game" }]);
  });

  it("fits Entries to the Map's Spawn Zones", async () => {
    const corners = await createMap(alice, FOUR_CORNERS);
    const game = await createGame(alice, corners, { pointBudget: 800, playerCount: 4 });
    const mine = await design(bob);
    const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ designId: mine, name: `Bot ${String(i)}` }));
    // The largest zone holds 3 Bots.
    expect(errorOf(await submit(bob, game.id, bots(4))).details).toEqual([
      { path: "bots", message: "has 4 Bots, more than any Spawn Zone of this Map holds (at most 3)" },
    ]);
    expect((await submit(bob, game.id, bots(3))).status).toBe(201);
  });

  it("lets only the owner withdraw an Entry, freeing its slot", async () => {
    const game = await createGame(alice, mapId);
    const { entry } = await enter(bob, game.id, [{ designId: await design(bob), name: "Rex" }]);

    const stranger = await call("DELETE", `/games/${game.id}/entries/${entry.id}`, { token: carol });
    expect(stranger.status).toBe(403);
    expect((await call("DELETE", `/games/${game.id}/entries/nope`, { token: bob })).status).toBe(404);
    expect((await call("DELETE", `/games/nope/entries/${entry.id}`, { token: bob })).status).toBe(404);

    expect((await call("DELETE", `/games/${game.id}/entries/${entry.id}`, { token: bob })).status).toBe(204);
    const after = await getGame(alice, game.id);
    expect(after).toMatchObject({ state: "open", entryCount: 0, entries: [] });
    expect((await call("DELETE", `/games/${game.id}/entries/${entry.id}`, { token: bob })).status).toBe(404);

    // The freed Bot Name and slot can be taken again.
    await enter(carol, game.id, [{ designId: await design(carol), name: "Rex" }]);
    expect((await getGame(alice, game.id)).entryCount).toBe(1);
  });

  it("lets exactly one of two racing Entries take the last slot", async () => {
    const game = await createGame(alice, mapId);
    await enter(alice, game.id, [{ designId: await design(alice), name: "First" }]);
    const bobDesign = await design(bob);
    const carolDesign = await design(carol);

    const results = await Promise.all([
      submit(bob, game.id, [{ designId: bobDesign, name: "Bob's" }]),
      submit(carol, game.id, [{ designId: carolDesign, name: "Carol's" }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser === undefined ? undefined : errorOf(loser).code).toBe("game_not_open");

    const final = await getGame(alice, game.id);
    expect(final).toMatchObject({ state: "running", entryCount: 2 });
    expect(final.entries).toHaveLength(2);
  });

  it("lets exactly one of two racing Entries take a Bot Name", async () => {
    const game = await createGame(alice, mapId, { playerCount: 2 });
    const results = await Promise.all([
      submit(bob, game.id, [{ designId: await design(bob), name: "Rex" }]),
      submit(carol, game.id, [{ designId: await design(carol), name: "rex" }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await getGame(alice, game.id)).toMatchObject({ state: "open", entryCount: 1 });
  });
});

describe("cancelling", () => {
  it("lets only the Initiator cancel an Open Game", async () => {
    const game = await createGame(alice, mapId);
    const { entry } = await enter(bob, game.id, [{ designId: await design(bob), name: "Rex" }]);

    const stranger = await call("POST", `/games/${game.id}/cancel`, { token: bob });
    expect(stranger.status).toBe(403);
    expect((await call("POST", "/games/nope/cancel", { token: alice })).status).toBe(404);

    advance(30);
    const cancelled = await call("POST", `/games/${game.id}/cancel`, { token: alice });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      state: "cancelled",
      cancelReason: "initiator",
      endedAt: "2026-03-01T12:00:30.000Z",
      startedAt: null,
      entryCount: 1,
    });
    // Builds stay hidden in a Game that never ran.
    expect((await getGame(carol, game.id)).entries[0]?.bots).toEqual([{ name: "Rex" }]);

    const again = await call("POST", `/games/${game.id}/cancel`, { token: alice });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe("game_not_open");
    expect((await submit(carol, game.id, [{ designId: await design(carol), name: "Late" }])).status).toBe(409);
    expect((await call("DELETE", `/games/${game.id}/entries/${entry.id}`, { token: bob })).status).toBe(409);
  });

  it("cannot cancel a Running Game", async () => {
    const game = await createGame(alice, mapId);
    await enter(bob, game.id, [{ designId: await design(bob), name: "A" }]);
    await enter(carol, game.id, [{ designId: await design(carol), name: "B" }]);
    const response = await call("POST", `/games/${game.id}/cancel`, { token: alice });
    expect(response.status).toBe(409);
    expect(errorOf(response).message).toContain("running");
  });

  it("cancels a Game that is not full by its fill deadline", async () => {
    const game = await createGame(alice, mapId, { fillTimeoutSeconds: 60 });
    await enter(bob, game.id, [{ designId: await design(bob), name: "Rex" }]);
    const carolDesign = await design(carol);

    advance(59);
    expect((await getGame(alice, game.id)).state).toBe("open");
    expect(await browse(carol)).toHaveLength(1);

    advance(1);
    expect(await browse(carol)).toEqual([]);
    expect(await getGame(alice, game.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "fill_timeout",
      endedAt: "2026-03-01T12:01:00.000Z",
    });
    const late = await submit(carol, game.id, [{ designId: carolDesign, name: "Late" }]);
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe("game_not_open");
  });

  it("records the fill deadline as the end even when observed later", async () => {
    const game = await createGame(alice, mapId, { fillTimeoutSeconds: 60 });
    advance(3600);
    const cancel = await call("POST", `/games/${game.id}/cancel`, { token: alice });
    expect(cancel.status).toBe(409);
    expect(await getGame(alice, game.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "fill_timeout",
      endedAt: "2026-03-01T12:01:00.000Z",
    });
  });
});

describe("my Games", () => {
  it("lists Games you initiated or entered, filtered by state", async () => {
    const initiated = await createGame(alice, mapId);
    advance(1);
    const entered = await createGame(bob, mapId);
    await enter(alice, entered.id, [{ designId: await design(alice), name: "A" }]);
    await enter(carol, entered.id, [{ designId: await design(carol), name: "C" }]);
    advance(1);
    const unrelated = await createGame(bob, mapId);
    advance(1);
    const cancelled = await createGame(alice, mapId);
    await call("POST", `/games/${cancelled.id}/cancel`, { token: alice });

    const mine = async (query = "") => {
      const response = await call("GET", `/players/me/games${query}`, { token: alice });
      expect(response.status).toBe(200);
      return (response.body as { games: Game[] }).games.map((g) => g.id);
    };
    expect(await mine()).toEqual([cancelled.id, entered.id, initiated.id]);
    expect(await mine("?state=open")).toEqual([initiated.id]);
    expect(await mine("?state=running,cancelled")).toEqual([cancelled.id, entered.id]);
    expect(await mine("?state=finished")).toEqual([]);
    expect((await call("GET", "/players/me/games?state=done", { token: alice })).status).toBe(400);
    expect((await call("GET", "/players/me/games")).status).toBe(401);
    expect(await mine()).not.toContain(unrelated.id);
  });
});

describe("deleting Revisions", () => {
  it("deletes Bot Design Revisions no Game uses, but never the latest", async () => {
    const id = await design(bob);
    for (let i = 0; i < 2; i++) {
      expect(
        (await call("POST", `/bot-designs/${id}/revisions`, { token: bob, body: { build: CHEAP_BUILD, program: PROGRAM } }))
          .status,
      ).toBe(201);
    }
    const game = await createGame(alice, mapId);
    const { entry } = await enter(bob, game.id, [{ designId: id, revision: 1, name: "Rex" }]);

    const inUse = await call("DELETE", `/bot-designs/${id}/revisions/1`, { token: bob });
    expect(inUse.status).toBe(409);
    expect(errorOf(inUse).code).toBe("revision_in_use");
    const latest = await call("DELETE", `/bot-designs/${id}/revisions/3`, { token: bob });
    expect(latest.status).toBe(409);
    expect(errorOf(latest).code).toBe("latest_revision");
    expect((await call("DELETE", `/bot-designs/${id}/revisions/2`, { token: carol })).status).toBe(404);
    expect((await call("DELETE", `/bot-designs/${id}/revisions/0`, { token: bob })).status).toBe(404);

    expect((await call("DELETE", `/bot-designs/${id}/revisions/2`, { token: bob })).status).toBe(204);
    expect((await call("GET", `/bot-designs/${id}/revisions/2`, { token: bob })).status).toBe(404);
    expect((await call("DELETE", `/bot-designs/${id}/revisions/2`, { token: bob })).status).toBe(404);
    const revisions = (await call("GET", `/bot-designs/${id}/revisions`, { token: bob })).body as {
      revisions: { number: number }[];
    };
    expect(revisions.revisions.map((r) => r.number)).toEqual([3, 1]);

    // Withdrawing the only Entry that used Revision 1 frees it.
    expect((await call("DELETE", `/games/${game.id}/entries/${entry.id}`, { token: bob })).status).toBe(204);
    expect((await call("DELETE", `/bot-designs/${id}/revisions/1`, { token: bob })).status).toBe(204);

    // New Revisions never reuse a deleted number.
    const next = await call("POST", `/bot-designs/${id}/revisions`, { token: bob, body: { build: CHEAP_BUILD, program: PROGRAM } });
    expect((next.body as { number: number }).number).toBe(4);
  });

  it("keeps Revisions used by Cancelled Games", async () => {
    const id = await design(bob);
    await call("POST", `/bot-designs/${id}/revisions`, { token: bob, body: { build: CHEAP_BUILD, program: PROGRAM } });
    const game = await createGame(alice, mapId);
    await enter(bob, game.id, [{ designId: id, revision: 1, name: "Rex" }]);
    await call("POST", `/games/${game.id}/cancel`, { token: alice });
    expect(errorOf(await call("DELETE", `/bot-designs/${id}/revisions/1`, { token: bob })).code).toBe("revision_in_use");
  });

  it("deletes Map Revisions no Game uses, for the creator only", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await call("POST", `/maps/${mapId}/revisions`, { token: alice, body: { map: DUEL } })).status).toBe(201);
    }
    await createGame(bob, mapId, { mapRevision: 1 });

    const inUse = await call("DELETE", `/maps/${mapId}/revisions/1`, { token: alice });
    expect(inUse.status).toBe(409);
    expect(errorOf(inUse).code).toBe("revision_in_use");
    expect(errorOf(await call("DELETE", `/maps/${mapId}/revisions/3`, { token: alice })).code).toBe("latest_revision");
    expect((await call("DELETE", `/maps/${mapId}/revisions/2`, { token: bob })).status).toBe(403);
    expect((await call("DELETE", `/maps/${mapId}/revisions/2`)).status).toBe(401);
    expect((await call("DELETE", `/maps/${mapId}/revisions/9`, { token: alice })).status).toBe(404);

    expect((await call("DELETE", `/maps/${mapId}/revisions/2`, { token: alice })).status).toBe(204);
    expect((await call("GET", `/maps/${mapId}/revisions/2`)).status).toBe(404);
    // Revisions of archived Maps can still be deleted.
    await call("POST", `/maps/${mapId}/revisions`, { token: alice, body: { map: DUEL } });
    await call("DELETE", `/maps/${mapId}`, { token: alice });
    expect((await call("DELETE", `/maps/${mapId}/revisions/3`, { token: alice })).status).toBe(204);
  });
});

describe("the OpenAPI document", () => {
  it("describes the Games endpoints", async () => {
    const document = (await call("GET", "/openapi.json")).body as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(document.paths["/games"] ?? {})).toEqual(["post", "get"]);
    expect(Object.keys(document.paths["/games/{gameId}/entries/{entryId}"] ?? {})).toEqual(["delete"]);
    expect(Object.keys(document.paths["/players/me/games"] ?? {})).toEqual(["get"]);
  });
});

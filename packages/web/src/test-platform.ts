/**
 * Stand-ins for the browser in tests: an in-memory history and storage, and
 * a fake API with the accounts endpoints the client signs in with, the
 * Games endpoints of the Games screen and Game page, the Rulesets and
 * Maps the Create Game screen chooses from, and the Bot Designs and Entries
 * of the Enter Game screen and the Garage, Map Revisions, and the Replays,
 * Parts Catalog, event streams and Emblems the viewer loads.
 */

import duelJson from "@positrontanks/ruleset-data/maps/duel.json";
import r1Json from "@positrontanks/ruleset-data/rulesets/r1.json";
import type { Schema } from "./api/client.js";
import type { BotDesignSummary, NewGameEntry } from "./entries.js";
import type { Game, MapSummary, NewGame, RulesetSummary } from "./games.js";
import type { HistoryLike } from "./router.js";
import type { SessionStorage } from "./session.js";

export function memoryHistory(start: string): HistoryLike & { readonly entries: string[]; back(): void } {
  const entries = [start];
  let index = 0;
  const listeners = new Set<() => void>();
  const location = () => {
    const url = new URL(entries[index] ?? "/", "http://client.test");
    return { pathname: url.pathname, search: url.search };
  };
  return {
    entries,
    get location() {
      return location();
    },
    pushState: (_data, _unused, url) => {
      entries.splice(index + 1, entries.length, url);
      index = entries.length - 1;
    },
    replaceState: (_data, _unused, url) => {
      entries[index] = url;
    },
    onPopState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    back: () => {
      index = Math.max(0, index - 1);
      for (const listener of listeners) listener();
    },
  };
}

export function memoryStorage(initial: Record<string, string> = {}): SessionStorage & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

export interface FakeApi {
  readonly fetch: typeof fetch;
  /** Every request, as "METHOD /path?query". */
  readonly requests: string[];
  /** The Games the fake serves, newest first; tests may change them. */
  readonly games: Game[];
  /** Ends every session, as if they had all expired. */
  expireSessions(): void;
}

/** One opening of a Game's event stream: the body's text, or null if the server cannot be reached. */
export type StreamOpening = string | null;

/** A `text/event-stream` event, as the server writes it. */
export function sseEvent(event: string, data: unknown, id?: number): string {
  return `event: ${event}\n${id === undefined ? "" : `id: ${String(id)}\n`}data: ${JSON.stringify(data)}\n\n`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, { error: { code, message, ...(details === undefined ? {} : { details }) } });

/** A Game for tests: Open, initiated by `p-ada_bot`, with no Entries, unless `fields` say otherwise. */
export function testGame(fields: Partial<Game> = {}): Game {
  const entries = fields.entries ?? [];
  return {
    id: "g1",
    state: "open",
    initiator: { id: "p-ada_bot", username: "ada_bot", emblem: null },
    rulesetVersion: "r1",
    map: { id: "m1", name: "Crossroads", revision: 2 },
    playerCount: 2,
    pointBudget: 1000,
    timeLimitSeconds: 120,
    pace: "realtime",
    fillTimeoutSeconds: 3600,
    createdAt: "2026-10-31T00:00:00.000Z",
    fillDeadline: "2026-10-31T01:00:00.000Z",
    startedAt: null,
    endedAt: null,
    cancelReason: null,
    result: null,
    entries,
    entryCount: entries.length,
    ...fields,
  };
}

export const TEST_RULESETS: readonly RulesetSummary[] = [{ version: "r1", tickRate: 20, pointBudget: { min: 100, max: 2000 }, mapFormats: [1] }];

/** A Map for tests: the bundled duel Map, two Spawn Zones, by `fields.id` (default `m1`). */
export function testMap(fields: Partial<Schema<"Map">> = {}): Schema<"Map"> {
  const map = duelJson as Schema<"MapFormat1">;
  return {
    id: "m1",
    name: "Duel",
    description: "Two Players, face to face.",
    creator: { id: "p-ada_bot", username: "ada_bot", emblem: null },
    latestRevision: { mapId: fields.id ?? "m1", number: 1, map, notes: "", createdAt: "2026-10-31T00:00:00.000Z" },
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    archivedAt: null,
    ...fields,
  };
}

/** A Bot Design for tests: `d1`, `Hunter`, in Ruleset r1, at Revision 1 costing 400, unless `fields` say otherwise. */
export function testDesign(fields: Partial<BotDesignSummary> & { readonly cost?: number } = {}): BotDesignSummary {
  const { cost = 400, ...rest } = fields;
  return {
    id: "d1",
    name: "Hunter",
    description: "",
    rulesetVersion: "r1",
    latestRevision: { number: 1, cost, notes: "", createdAt: "2026-10-31T00:00:00.000Z" },
    copiedFrom: null,
    icon: null,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    archivedAt: null,
    ...rest,
  };
}

/** The Build every test Bot Design has: an r1 Scout with a Pellet Gun, Radar and Wheels, and light front Armor. */
export const TEST_BUILD: Schema<"Build"> = {
  chassis: "scout",
  components: { gun: "pelletGun", eye: "radar", drive: "wheels" },
  armor: { front: "lightPlate", left: null, right: null, rear: null },
};

/** Revision `number` of a test Bot Design: notes `Revision n`, and Revision 1's cost less 10 points for each later one. */
export function testDesignRevision(design: BotDesignSummary, number: number): Schema<"BotDesignRevision"> {
  const latest = design.latestRevision;
  return {
    designId: design.id,
    number,
    build: TEST_BUILD,
    program: `-- ${design.name}, Revision ${String(number)}
`,
    cost: number === latest.number ? latest.cost : latest.cost - 10 * (latest.number - number),
    notes: number === latest.number ? latest.notes : `Revision ${String(number)}`,
    createdAt: latest.createdAt,
  };
}

export function mapSummary(map: Schema<"Map">): MapSummary {
  const { map: format, ...revision } = map.latestRevision;
  return {
    ...map,
    latestRevision: { ...revision, format: format.format, width: format.width, height: format.height, spawnZones: format.spawnZones.length },
  };
}

/**
 * A fake of the API's accounts, Games, Rulesets, Maps, Bot Designs and
 * Replays endpoints and Emblem images, all but signing up and logging in
 * needing a session. Every Player has the same `designs`; a Finished Game's
 * Replay is in `replays`, by Game id; Emblems are in `emblems`; the Parts
 * Catalog is r1's. Each opening of a
 * Running Game's stream takes the next of its `streams`, by Game id; once
 * they run out, the server is unavailable.
 */
export function fakeApi(
  options: {
    readonly games?: readonly Game[];
    readonly maps?: readonly Schema<"Map">[];
    readonly designs?: readonly BotDesignSummary[];
    readonly replays?: Readonly<Record<string, unknown>>;
    readonly streams?: Readonly<Record<string, readonly StreamOpening[]>>;
    /** Emblem images, by "playerId/hash". */
    readonly emblems?: Readonly<Record<string, Uint8Array<ArrayBuffer>>>;
  } = {},
): FakeApi {
  const games = [...(options.games ?? [])];
  const maps = options.maps ?? [testMap()];
  const designs = options.designs ?? [testDesign()];
  const passwords = new Map<string, string>();
  const sessions = new Map<string, string>();
  const requests: string[] = [];
  const openings = new Map(Object.entries(options.streams ?? {}).map(([id, list]) => [id, [...list]]));
  let next = 1;

  const page = (list: readonly Game[], query: URLSearchParams) => {
    const start = Number(query.get("cursor") ?? "0");
    const limit = Number(query.get("limit") ?? "50");
    const end = start + limit;
    const summaries = list.slice(start, end).map((game) => {
      const summary: Partial<Game> = { ...game };
      delete summary.entries;
      return summary;
    });
    return json(200, { games: summaries, nextCursor: end < list.length ? String(end) : null });
  };

  const handle = (method: string, path: string, query: URLSearchParams, auth: string | null, body: unknown): Response => {
    const player = (username: string) => ({ id: `p-${username}`, username, emblem: null, createdAt: "2026-10-31T00:00:00.000Z" });
    const credentials = body as { username: string; password: string };
    const token = auth?.replace(/^Bearer /, "");
    const signedIn = token === undefined ? undefined : sessions.get(token);
    if (method === "POST" && path === "/players") {
      if (credentials.password.length < 8) {
        return error(422, "validation_failed", "The request is invalid", [{ path: "password", message: "must be 8 to 256 characters" }]);
      }
      if (passwords.has(credentials.username)) return error(409, "username_taken", `The username "${credentials.username}" is already taken`);
      passwords.set(credentials.username, credentials.password);
      return json(201, player(credentials.username));
    }
    if (method === "POST" && path === "/sessions") {
      if (passwords.get(credentials.username) !== credentials.password) {
        return error(401, "invalid_credentials", "The username or password is incorrect");
      }
      const created = `pts_${String(next++)}`;
      sessions.set(created, credentials.username);
      return json(201, { token: created, expiresAt: "2099-01-01T00:00:00.000Z", player: player(credentials.username) });
    }
    if (signedIn === undefined || token === undefined) return error(401, "unauthorized", "The session token is invalid or has expired; log in again");
    if (method === "DELETE" && path === "/sessions/current") {
      sessions.delete(token);
      return new Response(null, { status: 204 });
    }
    const me = `p-${signedIn}`;
    if (method === "GET" && path === "/games") {
      const number = (name: string) => (query.has(name) ? Number(query.get(name)) : undefined);
      const [ruleset, map, players, min, max] = [query.get("rulesetVersion"), query.get("mapId"), number("playerCount"), number("minPointBudget"), number("maxPointBudget")];
      return page(
        games.filter(
          (g) =>
            g.state === "open" &&
            (ruleset === null || g.rulesetVersion === ruleset) &&
            (map === null || g.map.id === map) &&
            (players === undefined || g.playerCount === players) &&
            (min === undefined || g.pointBudget >= min) &&
            (max === undefined || g.pointBudget <= max),
        ),
        query,
      );
    }
    if (method === "GET" && path === "/players/me/games") {
      const states = query.get("state")?.split(",");
      const mine = games.filter((g) => g.initiator.id === me || g.entries.some((e) => e.player.id === me));
      return page(states === undefined ? mine : mine.filter((g) => states.includes(g.state)), query);
    }
    const emblemMatch = /^\/players\/([^/]+)\/emblem\/([^/]+)$/.exec(path);
    if (method === "GET" && emblemMatch !== null) {
      const image = options.emblems?.[`${decodeURIComponent(emblemMatch[1] ?? "")}/${decodeURIComponent(emblemMatch[2] ?? "")}`];
      if (image === undefined) return error(404, "not_found", "Not found");
      return new Response(image, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (method === "GET" && path === "/rulesets") return json(200, { rulesets: TEST_RULESETS });
    if (method === "GET" && path === "/rulesets/r1/parts") {
      const { version, slotTypes, chassisStats, componentKinds, chassis, components } = r1Json;
      return json(200, { version, slotTypes, chassisStats, componentKinds, chassis, components });
    }
    if (method === "GET" && path === "/bot-designs") {
      const ruleset = query.get("rulesetVersion");
      return json(200, { botDesigns: designs.filter((d) => ruleset === null || d.rulesetVersion === ruleset), nextCursor: null });
    }
    const designMatch = /^\/bot-designs\/([^/]+)(\/revisions(?:\/(\d+))?)?$/.exec(path);
    if (method === "GET" && designMatch !== null) {
      const design = designs.find((d) => d.id === decodeURIComponent(designMatch[1] ?? ""));
      if (design === undefined) return error(404, "not_found", "Not found");
      const numbers = Array.from({ length: design.latestRevision.number }, (_, i) => design.latestRevision.number - i);
      if (designMatch[2] === undefined) return json(200, { ...design, latestRevision: testDesignRevision(design, design.latestRevision.number) });
      if (designMatch[3] === undefined) {
        const revisions = numbers.map((n) => {
          const { number, cost, notes, createdAt } = testDesignRevision(design, n);
          return { number, cost, notes, createdAt };
        });
        return json(200, { revisions, nextCursor: null });
      }
      const number = Number(designMatch[3]);
      return numbers.includes(number) ? json(200, testDesignRevision(design, number)) : error(404, "not_found", "Not found");
    }
    if (method === "GET" && path === "/maps") {
      const creator = query.get("creator");
      return json(200, { maps: maps.filter((m) => creator === null || m.creator.username === creator).map(mapSummary), nextCursor: null });
    }
    const mapMatch = /^\/maps\/([^/]+)(\/revisions(?:\/(\d+))?)?$/.exec(path);
    if (method === "GET" && mapMatch !== null) {
      const map = maps.find((m) => m.id === decodeURIComponent(mapMatch[1] ?? ""));
      if (map === undefined) return error(404, "not_found", "Not found");
      if (mapMatch[2] === undefined) return json(200, map);
      // Every earlier Revision of a test Map is the same as its latest but for its notes.
      const latest = map.latestRevision;
      const numbers = Array.from({ length: latest.number }, (_, i) => latest.number - i);
      const revision = (n: number) => ({ ...latest, number: n, notes: n === latest.number ? latest.notes : `Revision ${String(n)}` });
      if (mapMatch[3] === undefined) {
        const revisions = numbers.map((n) => mapSummary({ ...map, latestRevision: revision(n) }).latestRevision);
        return json(200, { revisions, nextCursor: null });
      }
      const number = Number(mapMatch[3]);
      return numbers.includes(number) ? json(200, revision(number)) : error(404, "not_found", "Not found");
    }
    if (method === "POST" && path === "/games") {
      const created = body as NewGame;
      const map = maps.find((m) => m.id === created.mapId);
      const details = [];
      if (map === undefined) details.push({ path: "mapId", message: "is not a Map" });
      const zones = map?.latestRevision.map.spawnZones.length ?? Number.MAX_SAFE_INTEGER;
      if (created.playerCount < 2 || created.playerCount > zones) {
        details.push({ path: "playerCount", message: `must be an integer from 2 to ${String(zones)}` });
      }
      if (details.length > 0) return error(422, "validation_failed", "The request is invalid", details);
      const game = testGame({
        id: `g${String(next++)}`,
        initiator: { id: me, username: signedIn, emblem: null },
        rulesetVersion: created.rulesetVersion,
        map: { id: created.mapId, name: map?.name ?? "", revision: map?.latestRevision.number ?? 1 },
        playerCount: created.playerCount,
        pointBudget: created.pointBudget,
        timeLimitSeconds: created.timeLimitSeconds,
        pace: created.pace,
        fillTimeoutSeconds: created.fillTimeoutSeconds,
      });
      games.unshift(game);
      return json(201, game);
    }
    const match = /^\/games\/([^/]+)(\/cancel|\/replay|\/stream|\/entries|\/entries\/([^/]+))?$/.exec(path);
    const game = match?.[1] === undefined ? undefined : games.find((g) => g.id === decodeURIComponent(match[1] ?? ""));
    if (match === null || game === undefined) return error(404, "not_found", "Not found");
    const index = games.indexOf(game);
    if (method === "GET" && match[2] === undefined) return json(200, game);
    if (method === "GET" && match[2] === "/replay") {
      if (game.state !== "finished") return error(409, "game_not_finished", `Game ${game.id} is ${game.state}; its Replay comes once it is Finished`);
      return json(200, { game, replay: options.replays?.[game.id] });
    }
    if (method === "GET" && match[2] === "/stream") {
      if (game.state === "open") return error(409, "game_not_started", `Game ${game.id} has not started`);
      const opening = openings.get(game.id)?.shift();
      if (opening === undefined) return error(503, "unavailable", "The server is unavailable");
      if (opening === null) throw new TypeError("Failed to fetch");
      return new Response(opening, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && match[2] === "/cancel") {
      if (game.initiator.id !== me) return error(403, "forbidden", "Only the Game's Initiator may cancel it");
      if (game.state !== "open") return error(409, "game_not_open", `The Game is ${game.state}, not open`);
      games[index] = { ...game, state: "cancelled", cancelReason: "initiator", endedAt: "2026-10-31T00:30:00.000Z" };
      return json(200, games[index]);
    }
    if (method === "POST" && match[2] === "/entries") {
      if (game.state !== "open") return error(409, "game_not_open", `The Game is ${game.state}, not open`);
      const { bots } = body as NewGameEntry;
      const taken = new Set(game.entries.flatMap((e) => e.bots.map((b) => b.name.toLowerCase())));
      const details: { path: string; message: string }[] = [];
      let cost = 0;
      bots.forEach((bot, i) => {
        const design = designs.find((d) => d.id === bot.designId && d.rulesetVersion === game.rulesetVersion);
        if (design === undefined) details.push({ path: `bots[${String(i)}].designId`, message: "is not one of your Bot Designs" });
        cost += design?.latestRevision.cost ?? 0;
        if (taken.has(bot.name.toLowerCase())) details.push({ path: `bots[${String(i)}].name`, message: "is already taken in this Game" });
      });
      if (cost > game.pointBudget) {
        details.push({ path: "bots", message: `cost ${String(cost)} points, more than this Game's Point Budget of ${String(game.pointBudget)}` });
      }
      if (details.length > 0) return error(422, "validation_failed", "The request is invalid", details);
      const entry = {
        id: `e${String(next++)}`,
        player: { id: me, username: signedIn, emblem: null },
        createdAt: "2026-10-31T00:10:00.000Z",
        cost,
        bots: bots.map((bot) => ({ name: bot.name, design: { designId: bot.designId, revision: bot.revision ?? 1 } })),
      };
      const entries = [...game.entries, entry];
      const full = entries.length === game.playerCount;
      games[index] = { ...game, entries, entryCount: entries.length, ...(full ? { state: "running", startedAt: "2026-10-31T00:10:00.000Z" } : {}) };
      return json(201, { entry, game: games[index] });
    }
    if (method === "DELETE" && match[3] !== undefined) {
      const entry = game.entries.find((e) => e.id === decodeURIComponent(match[3] ?? ""));
      if (entry?.player.id !== me) return error(404, "not_found", "No such Entry of yours");
      if (game.state !== "open") return error(409, "game_not_open", `The Game is ${game.state}, not open`);
      const entries = game.entries.filter((e) => e !== entry);
      games[index] = { ...game, entries, entryCount: entries.length };
      return new Response(null, { status: 204 });
    }
    return error(404, "not_found", "Not found");
  };

  return {
    requests,
    games,
    expireSessions: () => {
      sessions.clear();
    },
    fetch: (input, init) => {
      const method = init?.method ?? "GET";
      const target = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
      requests.push(`${method} ${target}`);
      const url = new URL(target, "http://api.test");
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      try {
        return Promise.resolve(handle(method, url.pathname, url.searchParams, headers.get("authorization"), body));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

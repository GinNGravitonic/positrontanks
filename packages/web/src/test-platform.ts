/**
 * Stand-ins for the browser in tests: an in-memory history and storage, and
 * a fake API with the accounts endpoints the client signs in with and the
 * Games endpoints of the Games screen and Game page.
 */

import type { Game } from "./games.js";
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
    initiator: { id: "p-ada_bot", username: "ada_bot" },
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

/** A fake of the API's accounts and Games endpoints, all but signing up and logging in needing a session. */
export function fakeApi(options: { readonly games?: readonly Game[] } = {}): FakeApi {
  const games = [...(options.games ?? [])];
  const passwords = new Map<string, string>();
  const sessions = new Map<string, string>();
  const requests: string[] = [];
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
    const player = (username: string) => ({ id: `p-${username}`, username, createdAt: "2026-10-31T00:00:00.000Z" });
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
    const match = /^\/games\/([^/]+)(\/cancel|\/entries\/([^/]+))?$/.exec(path);
    const game = match?.[1] === undefined ? undefined : games.find((g) => g.id === decodeURIComponent(match[1] ?? ""));
    if (match === null || game === undefined) return error(404, "not_found", "Not found");
    const index = games.indexOf(game);
    if (method === "GET" && match[2] === undefined) return json(200, game);
    if (method === "POST" && match[2] === "/cancel") {
      if (game.initiator.id !== me) return error(403, "forbidden", "Only the Game's Initiator may cancel it");
      if (game.state !== "open") return error(409, "game_not_open", `The Game is ${game.state}, not open`);
      games[index] = { ...game, state: "cancelled", cancelReason: "initiator", endedAt: "2026-10-31T00:30:00.000Z" };
      return json(200, games[index]);
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
      return Promise.resolve(handle(method, url.pathname, url.searchParams, headers.get("authorization"), body));
    },
  };
}

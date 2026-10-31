/**
 * Stand-ins for the browser in tests: an in-memory history and storage, and
 * a fake API with the accounts endpoints the client signs in with.
 */

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
  /** Every request, as "METHOD /path". */
  readonly requests: string[];
  /** Ends every session, as if they had all expired. */
  expireSessions(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (status: number, code: string, message: string, details?: unknown[]) =>
  json(status, { error: { code, message, ...(details === undefined ? {} : { details }) } });

/** A fake of the API's accounts endpoints, plus `GET /games/{id}` that needs a session. */
export function fakeApi(): FakeApi {
  const passwords = new Map<string, string>();
  const sessions = new Map<string, string>();
  const requests: string[] = [];
  let next = 1;

  const handle = (method: string, path: string, auth: string | null, body: unknown): Response => {
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
    if (method === "GET" && path.startsWith("/games/")) return json(200, { id: path.slice("/games/".length) });
    return error(404, "not_found", "Not found");
  };

  return {
    requests,
    expireSessions: () => {
      sessions.clear();
    },
    fetch: (input, init) => {
      const method = init?.method ?? "GET";
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      requests.push(`${method} ${path}`);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      return Promise.resolve(handle(method, path, headers.get("authorization"), body));
    },
  };
}

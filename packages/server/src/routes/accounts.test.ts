import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../accounts/secrets.js";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";

const config: ServerConfig = { ...defaultConfig, port: 0, databasePath: ":memory:" };
const quiet: Logger = { info: () => undefined, error: () => undefined };

let running: RunningServer;

beforeEach(async () => {
  running = await startServer(config, { logger: quiet });
});

afterEach(async () => {
  await running.close();
});

interface Response {
  status: number;
  headers: Headers;
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
  return { status: response.status, headers: response.headers, body: text === "" ? undefined : JSON.parse(text) };
}

const errorCode = (response: Response): unknown => (response.body as { error?: { code?: unknown } }).error?.code;

const PASSWORD = "correct horse battery";

async function signUp(username = "Ada_Bot", password = PASSWORD): Promise<Response> {
  return call("POST", "/players", { body: { username, password } });
}

async function logIn(username = "Ada_Bot", password = PASSWORD): Promise<Response> {
  return call("POST", "/sessions", { body: { username, password } });
}

async function sessionToken(username = "Ada_Bot"): Promise<string> {
  await signUp(username);
  return ((await logIn(username)).body as { token: string }).token;
}

async function createKey(token: string, name = "laptop"): Promise<{ key: string; apiKey: { id: string } }> {
  const response = await call("POST", "/api-keys", { token, body: { name } });
  expect(response.status).toBe(201);
  return response.body as { key: string; apiKey: { id: string } };
}

describe("sign up", () => {
  it("creates a Player, keeping the username's case", async () => {
    const response = await signUp();
    expect(response.status).toBe(201);
    const player = response.body as Record<string, unknown>;
    expect(Object.keys(player).sort()).toEqual(["createdAt", "emblem", "id", "username"]);
    expect(player.emblem).toBeNull();
    expect(player.username).toBe("Ada_Bot");
    expect(typeof player.id).toBe("string");
    expect(Number.isNaN(Date.parse(String(player.createdAt)))).toBe(false);
  });

  it("does not store the password in the clear", async () => {
    await signUp();
    const stored = running.services.db.accounts.findPasswordCredential("ada_bot");
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
  });

  it("rejects a username already taken in any case", async () => {
    await signUp("Ada_Bot");
    const response = await signUp("ADA_bot");
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("username_taken");
  });

  it.each(["ab", "a".repeat(33), "has space", "dot.ted", "émile", ""])("rejects the username %j", async (name) => {
    const response = await signUp(name);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: "validation_failed", details: [{ path: "username" }] } });
  });

  it("accepts usernames at the limits", async () => {
    expect((await signUp("a-_")).status).toBe(201);
    expect((await signUp("Z9".repeat(16))).status).toBe(201);
  });

  it("rejects short passwords, missing, mistyped and unknown fields, all at once", async () => {
    const short = await signUp("someone", "short");
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({ error: { details: [{ path: "password" }] } });

    const messy = await call("POST", "/players", { body: { username: 7, extra: true } });
    expect(messy.status).toBe(422);
    const paths = (messy.body as { error: { details: { path: string }[] } }).error.details.map((d) => d.path);
    expect(paths.sort()).toEqual(["extra", "password", "username"]);

    expect((await call("POST", "/players", { body: ["x"] })).status).toBe(422);
  });
});

describe("log in", () => {
  it("returns a session token that authenticates as the Player", async () => {
    const player = (await signUp()).body as { id: string };
    const response = await logIn("ada_BOT");
    expect(response.status).toBe(201);
    const session = response.body as { token: string; expiresAt: string; player: { id: string } };
    expect(session.token).toMatch(/^aus_/);
    expect(session.player.id).toBe(player.id);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());

    const me = await call("GET", "/players/me", { token: session.token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: player.id, username: "Ada_Bot" });
  });

  it("rejects a wrong password and an unknown username the same way", async () => {
    await signUp();
    const wrong = await logIn("Ada_Bot", "not the password");
    const unknown = await logIn("nobody", PASSWORD);
    const invalid = await logIn("no such name!", PASSWORD);
    for (const response of [wrong, unknown, invalid]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: "invalid_credentials", message: "The username or password is incorrect" },
      });
    }
  });

  it("logs out, after which the token is rejected", async () => {
    const token = await sessionToken();
    expect((await call("DELETE", "/sessions/current", { token })).status).toBe(204);
    const me = await call("GET", "/players/me", { token });
    expect(me.status).toBe(401);
    expect(errorCode(me)).toBe("unauthorized");
  });

  it("does not accept an expired session", async () => {
    const token = await sessionToken();
    const accounts = running.services.db.accounts;
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(accounts.findSessionPlayer(hashToken(token), new Date())).toBeDefined();
    expect(accounts.findSessionPlayer(hashToken(token), later)).toBeUndefined();
    expect(accounts.deleteExpiredSessions(later)).toBe(1);
    expect((await call("GET", "/players/me", { token })).status).toBe(401);
  });
});

describe("authentication", () => {
  it.each([
    ["no header", undefined],
    ["a made-up session token", "aus_madeup"],
    ["a made-up API key", "auk_madeup"],
    ["an unknown kind of token", "something"],
  ])("rejects %s with 401 and a Bearer challenge", async (_, token) => {
    const response = await call("GET", "/players/me", token === undefined ? {} : { token });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("unauthorized");
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const response = await fetch(`${running.url}/players/me`, { headers: { authorization: "Basic YTpi" } });
    expect(response.status).toBe(401);
  });
});

describe("API keys", () => {
  it("are created once, authenticate as the Player, and are listed without the secret", async () => {
    const token = await sessionToken();
    const created = await createKey(token, "  ci runner  ");
    expect(created.key).toMatch(/^auk_[A-Za-z0-9_-]{43}$/);
    expect(created.apiKey).toMatchObject({ name: "ci runner", prefix: created.key.slice(0, 12), lastUsedAt: null });

    const me = await call("GET", "/players/me", { token: created.key });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: "Ada_Bot" });

    const list = await call("GET", "/api-keys", { token });
    expect(list.status).toBe(200);
    const keys = (list.body as { apiKeys: { id: string; lastUsedAt: string | null }[] }).apiKeys;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(created.apiKey.id);
    expect(keys[0]?.lastUsedAt).toEqual(expect.any(String));
    expect(JSON.stringify(list.body)).not.toContain(created.key);
  });

  it("can manage keys when authenticated by a key", async () => {
    const token = await sessionToken();
    const first = await createKey(token, "first");
    const second = await createKey(first.key, "second");
    const list = await call("GET", "/api-keys", { token: second.key });
    expect((list.body as { apiKeys: { name: string }[] }).apiKeys.map((k) => k.name)).toEqual(["first", "second"]);
  });

  it("stop working once revoked and drop out of the list", async () => {
    const token = await sessionToken();
    const keep = await createKey(token, "keep");
    const drop = await createKey(token, "drop");

    expect((await call("DELETE", `/api-keys/${drop.apiKey.id}`, { token })).status).toBe(204);
    const rejected = await call("GET", "/players/me", { token: drop.key });
    expect(rejected.status).toBe(401);
    expect(errorCode(rejected)).toBe("unauthorized");
    expect((await call("GET", "/players/me", { token: keep.key })).status).toBe(200);

    const list = await call("GET", "/api-keys", { token });
    expect((list.body as { apiKeys: { id: string }[] }).apiKeys.map((k) => k.id)).toEqual([keep.apiKey.id]);
    expect((await call("DELETE", `/api-keys/${drop.apiKey.id}`, { token })).status).toBe(404);
  });

  it("can revoke the key making the request", async () => {
    const token = await sessionToken();
    const key = await createKey(token);
    expect((await call("DELETE", `/api-keys/${key.apiKey.id}`, { token: key.key })).status).toBe(204);
    expect((await call("GET", "/players/me", { token: key.key })).status).toBe(401);
  });

  it("belong to one Player: others can neither see nor revoke them", async () => {
    const ada = await sessionToken("ada");
    const bob = await sessionToken("bob");
    const key = await createKey(ada);

    const bobsList = await call("GET", "/api-keys", { token: bob });
    expect(bobsList.body).toEqual({ apiKeys: [] });
    const revoke = await call("DELETE", `/api-keys/${key.apiKey.id}`, { token: bob });
    expect(revoke.status).toBe(404);
    expect((await call("GET", "/players/me", { token: key.key })).status).toBe(200);
  });

  it("require authentication and a valid name", async () => {
    expect((await call("POST", "/api-keys", { body: { name: "x" } })).status).toBe(401);
    expect((await call("GET", "/api-keys")).status).toBe(401);
    expect((await call("DELETE", "/api-keys/anything")).status).toBe(401);

    const token = await sessionToken();
    for (const name of ["   ", "x".repeat(65)]) {
      const response = await call("POST", "/api-keys", { token, body: { name } });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: { details: [{ path: "name" }] } });
    }
  });

  it("cannot be used to log out", async () => {
    const key = await createKey(await sessionToken());
    const response = await call("DELETE", "/sessions/current", { token: key.key });
    expect(response.status).toBe(400);
  });
});

describe("OpenAPI document", () => {
  it("describes the account endpoints and bearer authentication", async () => {
    const doc = (await call("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(doc.paths["/players"]?.post?.operationId).toBe("signUp");
    expect(doc.paths["/players"]?.post?.security).toEqual([]);
    expect(doc.paths["/sessions"]?.post?.operationId).toBe("logIn");
    expect(doc.paths["/api-keys"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(doc.paths["/api-keys/{apiKeyId}"] ?? {})).toEqual(["delete"]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Player", "Credentials", "Session", "ApiKey", "CreatedApiKey", "ApiKeyList"]),
    );
  });
});

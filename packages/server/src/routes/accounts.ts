/**
 * Accounts: signing up, logging in for a session token, and managing API
 * keys (spec section 9).
 *
 * Signing up creates a Player with a password credential. Logging in trades
 * the username and password for a short-lived session token; API keys are
 * long-lived and managed by the Player. Both are sent as
 * `Authorization: Bearer <token>`. Raw tokens are returned exactly once, when
 * created; the server keeps only their hashes.
 */

import { randomUUID } from "node:crypto";
import { authenticate, SESSION_TTL_MS } from "../accounts/auth.js";
import {
  API_KEY_PREFIX,
  generateToken,
  hashPassword,
  hashToken,
  SESSION_TOKEN_PREFIX,
  verifyDummyPassword,
  verifyPassword,
} from "../accounts/secrets.js";
import type { ApiKeyRecord, PlayerRecord } from "../db/accounts.js";
import { ApiError, badRequest, notFound, validationFailed, type ErrorDetail } from "../http/errors.js";
import type { ApiModule, Json } from "../http/router.js";

/** Spec section 10: 3–32 letters, digits, `-` and `_`; unique ignoring case. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const API_KEY_NAME_MAX_LENGTH = 64;
/** Characters of an API key kept as its visible prefix. */
const VISIBLE_KEY_CHARS = API_KEY_PREFIX.length + 8;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Accounts";

const usernameSchema: Json = {
  type: "string",
  pattern: USERNAME_PATTERN.source,
  description: "3–32 letters, digits, `-` and `_`. Unique ignoring case; the case given at signup is kept for display.",
  examples: ["ada_bot"],
};

const schemas: Record<string, Json> = {
  Player: {
    type: "object",
    required: ["id", "username", "createdAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      username: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Credentials: {
    type: "object",
    required: ["username", "password"],
    additionalProperties: false,
    properties: {
      username: usernameSchema,
      password: { type: "string", minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
    },
  },
  Session: {
    type: "object",
    required: ["token", "expiresAt", "player"],
    additionalProperties: false,
    properties: {
      token: { type: "string", description: "Send as `Authorization: Bearer <token>`." },
      expiresAt: { type: "string", format: "date-time" },
      player: ref("Player"),
    },
  },
  ApiKey: {
    type: "object",
    required: ["id", "name", "prefix", "createdAt", "lastUsedAt"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      prefix: { type: "string", description: "The start of the key, to tell keys apart." },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  NewApiKey: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: { type: "string", minLength: 1, maxLength: API_KEY_NAME_MAX_LENGTH } },
  },
  CreatedApiKey: {
    type: "object",
    required: ["key", "apiKey"],
    additionalProperties: false,
    properties: {
      key: { type: "string", description: "The API key itself. Shown only now; store it safely." },
      apiKey: ref("ApiKey"),
    },
  },
  ApiKeyList: {
    type: "object",
    required: ["apiKeys"],
    additionalProperties: false,
    properties: { apiKeys: { type: "array", items: ref("ApiKey") } },
  },
};

/** Reads a JSON object body with exactly the string fields `fields`, reporting every problem. */
function readStrings<K extends string>(body: unknown, fields: readonly K[]): Record<K, string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationFailed([{ path: "(body)", message: "must be a JSON object" }]);
  }
  const record = body as Record<string, unknown>;
  const details: ErrorDetail[] = [];
  for (const key of Object.keys(record)) {
    if (!(fields as readonly string[]).includes(key)) details.push({ path: key, message: "is not a known field" });
  }
  const out: Partial<Record<K, string>> = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) details.push({ path: field, message: "is required" });
    else if (typeof value !== "string") details.push({ path: field, message: "must be a string" });
    else out[field] = value;
  }
  if (details.length > 0) throw validationFailed(details);
  return out as Record<K, string>;
}

function checkPassword(password: string, details: ErrorDetail[]): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    details.push({
      path: "password",
      message: `must be ${String(PASSWORD_MIN_LENGTH)} to ${String(PASSWORD_MAX_LENGTH)} characters`,
    });
  }
}

const playerJson = (p: PlayerRecord): Json => ({ id: p.id, username: p.username, createdAt: p.createdAt });

const apiKeyJson = (k: ApiKeyRecord): Json => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
});

const invalidCredentials = (): ApiError =>
  new ApiError(401, "invalid_credentials", "The username or password is incorrect");

export const accountsModule: ApiModule = {
  tags: [{ name: TAG, description: "Signing up, logging in, and API keys." }],
  schemas,
  routes: [
    {
      method: "POST",
      path: "/players",
      operation: {
        operationId: "signUp",
        summary: "Sign up: create a Player with a username and password",
        description: "Does not log in; call `logIn` afterwards for a session token.",
        tags: [TAG],
        security: [],
        requestBody: { required: true, content: jsonContent(ref("Credentials")) },
        responses: {
          "201": { description: "The new Player.", content: jsonContent(ref("Player")) },
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async ({ readJson, services }) => {
        const { username, password } = readStrings(await readJson(), ["username", "password"]);
        const details: ErrorDetail[] = [];
        if (!USERNAME_PATTERN.test(username)) {
          details.push({ path: "username", message: "must be 3 to 32 letters, digits, '-' or '_'" });
        }
        checkPassword(password, details);
        if (details.length > 0) throw validationFailed(details);

        const passwordHash = await hashPassword(password);
        const player = services.db.accounts.createPasswordPlayer(randomUUID(), username, passwordHash, new Date());
        if (player === undefined) {
          throw new ApiError(409, "username_taken", `The username "${username}" is already taken`);
        }
        return { status: 201, body: playerJson(player) };
      },
    },
    {
      method: "GET",
      path: "/players/me",
      operation: {
        operationId: "getCurrentPlayer",
        summary: "Get the Player the request is authenticated as",
        tags: [TAG],
        security: bearer,
        responses: {
          "200": { description: "The authenticated Player.", content: jsonContent(ref("Player")) },
          "401": errorResponse,
        },
      },
      handler: (context) => ({ body: playerJson(authenticate(context).player) }),
    },
    {
      method: "POST",
      path: "/sessions",
      operation: {
        operationId: "logIn",
        summary: "Log in: exchange a username and password for a session token",
        description: `The token expires after ${String(SESSION_TTL_MS / 3_600_000)} hours. Use an API key for long-lived access.`,
        tags: [TAG],
        security: [],
        requestBody: { required: true, content: jsonContent(ref("Credentials")) },
        responses: {
          "201": { description: "A new session.", content: jsonContent(ref("Session")) },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async ({ readJson, services }) => {
        const { username, password } = readStrings(await readJson(), ["username", "password"]);
        const accounts = services.db.accounts;
        const found = USERNAME_PATTERN.test(username) ? accounts.findPasswordCredential(username) : undefined;
        if (found === undefined) {
          await verifyDummyPassword(password);
          throw invalidCredentials();
        }
        if (!(await verifyPassword(password, found.passwordHash))) throw invalidCredentials();

        const now = new Date();
        const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
        const token = generateToken(SESSION_TOKEN_PREFIX);
        services.db.transaction(() => {
          accounts.deleteExpiredSessions(now);
          accounts.createSession(hashToken(token), found.player.id, now, expiresAt);
        });
        return {
          status: 201,
          body: { token, expiresAt: expiresAt.toISOString(), player: playerJson(found.player) },
        };
      },
    },
    {
      method: "DELETE",
      path: "/sessions/current",
      operation: {
        operationId: "logOut",
        summary: "Log out: end the session whose token authenticates this request",
        tags: [TAG],
        security: bearer,
        responses: { "204": { description: "The session token no longer works." }, "400": errorResponse, "401": errorResponse },
      },
      handler: (context) => {
        const { credential } = authenticate(context);
        if (credential.kind !== "session") throw badRequest("This request is authenticated by an API key, not a session");
        context.services.db.accounts.deleteSession(credential.tokenHash);
        return {};
      },
    },
    {
      method: "POST",
      path: "/api-keys",
      operation: {
        operationId: "createApiKey",
        summary: "Create a long-lived API key",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: jsonContent(ref("NewApiKey")) },
        responses: {
          "201": { description: "The new key, shown only this once.", content: jsonContent(ref("CreatedApiKey")) },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const name = readStrings(await context.readJson(), ["name"]).name.trim();
        if (name.length === 0 || name.length > API_KEY_NAME_MAX_LENGTH) {
          throw validationFailed([
            { path: "name", message: `must be 1 to ${String(API_KEY_NAME_MAX_LENGTH)} characters` },
          ]);
        }
        const key = generateToken(API_KEY_PREFIX);
        const record = context.services.db.accounts.createApiKey(
          { id: randomUUID(), playerId: player.id, name, prefix: key.slice(0, VISIBLE_KEY_CHARS), tokenHash: hashToken(key) },
          new Date(),
        );
        return { status: 201, body: { key, apiKey: apiKeyJson(record) } };
      },
    },
    {
      method: "GET",
      path: "/api-keys",
      operation: {
        operationId: "listApiKeys",
        summary: "List the authenticated Player's API keys that are not revoked",
        tags: [TAG],
        security: bearer,
        responses: {
          "200": { description: "The keys, oldest first.", content: jsonContent(ref("ApiKeyList")) },
          "401": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        return { body: { apiKeys: context.services.db.accounts.listApiKeys(player.id).map(apiKeyJson) } };
      },
    },
    {
      method: "DELETE",
      path: "/api-keys/{apiKeyId}",
      operation: {
        operationId: "revokeApiKey",
        summary: "Revoke an API key",
        description: "The key stops working immediately. Revoking the key that authenticates the request is allowed.",
        tags: [TAG],
        security: bearer,
        parameters: [{ name: "apiKeyId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Revoked." }, "401": errorResponse, "404": errorResponse },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const id = context.params.apiKeyId ?? "";
        if (!context.services.db.accounts.revokeApiKey(player.id, id, new Date())) {
          throw notFound(`You have no API key ${id}`);
        }
        return {};
      },
    },
  ],
};

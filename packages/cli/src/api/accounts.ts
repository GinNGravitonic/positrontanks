/**
 * `aumohta auth` and `aumohta keys` (docs/spec/cli-api.md): accounts,
 * sessions and API keys.
 *
 * The CLI stores API keys, not session tokens, since a session expires
 * within hours: `auth login` logs in for a session only long enough to
 * create a key, stores the key and its id in the profile, and ends the
 * session. A key given by option or environment is never stored or revoked
 * by `auth`; `keys revoke` revokes any key explicitly.
 */

import { hostname } from "node:os";
import { ApiClient, CliError, EXIT, type Schema } from "./client.js";
import { maskKey, withProfile, type Profile } from "./config.js";
import { ago, emit, flag, readSecret, segment, str, type Context, type Group } from "./context.js";
import { table } from "../report.js";

type Player = Schema<"Player">;
type ApiKey = Schema<"ApiKey">;
type CreatedApiKey = Schema<"CreatedApiKey">;
type ApiKeyList = Schema<"ApiKeyList">;

const password = (context: Context, fromStdin: boolean) => readSecret(context, fromStdin, "--password-stdin", "Password: ");

function keySource({ settings }: Context): string {
  if (settings.apiKeySource === "option") return "--api-key-stdin";
  if (settings.apiKeySource === "environment") return "AUMOHTA_API_KEY";
  return `profile ${settings.profile}`;
}

/** The profile without its key, keeping its server. */
const withoutKey = ({ server }: Profile): Profile => (server === undefined ? {} : { server });

/** Stores a key in the chosen profile, with the server it belongs to. */
async function storeKey(context: Context, apiKey: string, apiKeyId: string, username: string): Promise<void> {
  const { profile, server } = context.settings;
  const stored = context.config.profiles[profile] ?? {};
  await context.saveConfig(withProfile(context.config, profile, { ...stored, server, apiKey, apiKeyId, username }));
  if (context.env.AUMOHTA_API_KEY !== undefined && context.env.AUMOHTA_API_KEY !== "") {
    context.io.err("Note: AUMOHTA_API_KEY is set, and takes precedence over the stored key.");
  }
}

/** The id of `key` among the Player's keys, matched by its visible start. */
async function keyIdOf(client: ApiClient, key: string): Promise<string> {
  const { apiKeys } = await client.request<ApiKeyList>("GET", "/api-keys", { auth: true });
  const match = apiKeys.find((k) => key.startsWith(k.prefix));
  if (match === undefined) throw new CliError(EXIT.server, "bad_response", "the server lists no API key matching this key");
  return match.id;
}

export const authCommands: Group = {
  signup: {
    synopsis: "USERNAME [--password-stdin]",
    summary: "Create a Player (POST /players); log in afterwards with 'auth login'",
    args: ["USERNAME"],
    options: { "password-stdin": { type: "boolean" } },
    run: async (context, [username = ""], values) => {
      const body = { username, password: await password(context, flag(values, "password-stdin")) };
      const player = await context.client.request<Player>("POST", "/players", { body });
      emit(context, player, () => [
        `Signed up ${player.username} (Player ${player.id}) on ${context.settings.server}.`,
        `Log in with: aumohta auth login ${player.username}`,
      ]);
    },
  },

  login: {
    synopsis: "USERNAME [--password-stdin] [--key-name NAME]",
    summary: "Log in, create an API key and store it in the profile",
    args: ["USERNAME"],
    options: { "password-stdin": { type: "boolean" }, "key-name": { type: "string" } },
    run: async (context, [username = ""], values) => {
      const body = { username, password: await password(context, flag(values, "password-stdin")) };
      const name = str(values, "key-name") ?? `aumohta-cli on ${hostname()}`;
      const { client } = context;
      const session = await client.request<Schema<"Session">>("POST", "/sessions", { body });
      let created: CreatedApiKey;
      try {
        created = await client.request<CreatedApiKey>("POST", "/api-keys", { token: session.token, body: { name } });
      } finally {
        // The session was only for creating the key.
        await client.request("DELETE", "/sessions/current", { token: session.token }).catch(() => undefined);
      }
      await storeKey(context, created.key, created.apiKey.id, session.player.username);
      emit(context, { ...created, key: maskKey(created.key) }, () => [
        `Logged in as ${session.player.username} on ${context.settings.server}.`,
        `Stored API key ${created.apiKey.id} ("${created.apiKey.name}") in profile ${context.settings.profile}.`,
      ]);
    },
  },

  "use-key": {
    synopsis: "[--api-key-stdin]",
    summary: "Store an API key you already have in the profile",
    run: async (context) => {
      const { settings } = context;
      const key = settings.apiKeySource === "option" && settings.apiKey !== undefined ? settings.apiKey : await readSecret(context, false, "--api-key-stdin", "API key: ");
      const client = new ApiClient(settings.server, key);
      const id = await keyIdOf(client, key);
      const player = await client.request<Player>("GET", "/players/me", { auth: true });
      await storeKey(context, key, id, player.username);
      emit(context, player, () => [`Stored API key ${id} of ${player.username} in profile ${settings.profile}.`]);
    },
  },

  logout: {
    synopsis: "",
    summary: "Revoke the profile's API key and forget it",
    run: async (context) => {
      const { profile, server } = context.settings;
      const stored: Profile = context.config.profiles[profile] ?? {};
      if (stored.apiKey === undefined) {
        throw new CliError(
          EXIT.notAuthenticated,
          "not_authenticated",
          `profile ${profile} has no stored API key; a key given by option or environment is never revoked by logout (use 'aumohta keys revoke KEY_ID')`,
        );
      }
      const client = new ApiClient(server, stored.apiKey);
      let revoked = true;
      try {
        const id = stored.apiKeyId ?? (await keyIdOf(client, stored.apiKey));
        await client.request("DELETE", `/api-keys/${segment(id)}`, { auth: true });
      } catch (e) {
        // A key the server no longer accepts is already revoked: forget it all the same.
        if (!(e instanceof CliError && (e.exitCode === EXIT.notAuthenticated || e.code === "not_found"))) throw e;
        revoked = false;
      }
      await context.saveConfig(withProfile(context.config, profile, withoutKey(stored)));
      const what = `API key ${stored.apiKeyId ?? maskKey(stored.apiKey)}`;
      emit(context, {}, () => [revoked ? `Revoked ${what} and removed it from profile ${profile}.` : `${what} was already revoked; removed it from profile ${profile}.`]);
    },
  },

  whoami: {
    synopsis: "",
    summary: "Show the Player the API key belongs to (GET /players/me)",
    run: async (context) => {
      const player = await context.client.request<Player>("GET", "/players/me", { auth: true });
      emit(context, player, () => [
        `${player.username} (Player ${player.id}) on ${context.settings.server}`,
        `Signed up ${ago(player.createdAt)}; API key from ${keySource(context)}.`,
      ]);
    },
  },
};

export const keysCommands: Group = {
  create: {
    synopsis: "NAME",
    summary: "Create an API key and print it once (it is not stored)",
    args: ["NAME"],
    run: async (context, [name = ""]) => {
      const created = await context.client.request<CreatedApiKey>("POST", "/api-keys", { auth: true, body: { name } });
      emit(context, created, () => [`Created API key ${created.apiKey.id} ("${created.apiKey.name}"). The key, shown only this once:`, created.key]);
    },
  },

  list: {
    synopsis: "",
    summary: "List your API keys (GET /api-keys)",
    run: async (context) => {
      const list = await context.client.request<ApiKeyList>("GET", "/api-keys", { auth: true });
      const own = context.config.profiles[context.settings.profile]?.apiKeyId;
      const row = (k: ApiKey) => [k.id === own ? "*" : " ", k.id, k.name, `${k.prefix}...`, ago(k.createdAt), ago(k.lastUsedAt)];
      emit(context, list, () =>
        list.apiKeys.length === 0 ? ["No API keys."] : table([[" ", "ID", "Name", "Prefix", "Created", "Last used"], ...list.apiKeys.map(row)], ""),
      );
    },
  },

  revoke: {
    synopsis: "KEY_ID",
    summary: "Revoke an API key (DELETE /api-keys/{apiKeyId})",
    args: ["KEY_ID"],
    run: async (context, [id = ""]) => {
      await context.client.request("DELETE", `/api-keys/${segment(id)}`, { auth: true });
      const { profile } = context.settings;
      const stored = context.config.profiles[profile] ?? {};
      const own = stored.apiKeyId === id;
      if (own) await context.saveConfig(withProfile(context.config, profile, withoutKey(stored)));
      emit(context, {}, () => [`Revoked API key ${id}.${own ? ` It was profile ${profile}'s key; removed it from the profile.` : ""}`]);
    },
  },
};

/**
 * `aumohta server`, `aumohta config` and `aumohta api` (docs/spec/cli-api.md):
 * the server itself, the profiles in the config file, and one request to
 * any endpoint.
 */

import { writeFile } from "node:fs/promises";
import { CliError, EXIT, inputError, parseJson, usageError, type Schema } from "./client.js";
import { checkProfileName, checkServerUrl, currentProfileName, DEFAULT_PROFILE, DEFAULT_SERVER, maskKey, withProfile, type Profile } from "./config.js";
import { emit, readInput, str, strs, type Command, type Group } from "./context.js";
import { table } from "../report.js";

export const serverCommands: Group = {
  info: {
    synopsis: "",
    summary: "Show the server's optional features (GET /server)",
    run: async (context) => {
      const info = await context.client.request<Schema<"Server">>("GET", "/server");
      emit(context, info, () => [
        `Server ${context.settings.server}`,
        "Features:",
        ...table(Object.entries(info.features).map(([name, on]) => [name, on ? "on" : "off"])),
      ]);
    },
  },

  health: {
    synopsis: "",
    summary: "Check that the server and its database are up (GET /health)",
    run: async (context) => {
      const health = await context.client.request<Schema<"Health">>("GET", "/health");
      emit(context, health, () => [`${context.settings.server}: ${health.status}`]);
    },
  },

  openapi: {
    synopsis: "[--out FILE]",
    summary: "Print or save the server's OpenAPI document (GET /openapi.json)",
    options: { out: { type: "string" } },
    run: async (context, _args, values) => {
      const document = await context.client.request<unknown>("GET", "/openapi.json");
      const text = JSON.stringify(document, null, 2);
      const out = str(values, "out");
      if (out === undefined) {
        context.io.out(text);
        return;
      }
      try {
        await writeFile(out, `${text}\n`);
      } catch (e) {
        throw inputError(`cannot write ${out}: ${(e as Error).message}`);
      }
      emit(context, {}, () => [`Wrote the OpenAPI document of ${context.settings.server} to ${out}.`]);
    },
  },
};

const maskedProfile = (profile: Profile): Profile => (profile.apiKey === undefined ? profile : { ...profile, apiKey: maskKey(profile.apiKey) });

export const configCommands: Group = {
  show: {
    synopsis: "",
    summary: "Show the profile in use and its settings, with the API key masked",
    run: (context) => {
      const { settings, config } = context;
      const stored = config.profiles[settings.profile] ?? {};
      const shown = {
        profile: settings.profile,
        configFile: context.configPath,
        server: settings.server,
        serverFrom: settings.serverSource,
        apiKey: settings.apiKey === undefined ? null : maskKey(settings.apiKey),
        apiKeyFrom: settings.apiKeySource ?? null,
        apiKeyId: settings.apiKeySource === "profile" ? (stored.apiKeyId ?? null) : null,
        username: settings.apiKeySource === "profile" ? (stored.username ?? null) : null,
      };
      emit(context, shown, () =>
        table(
          [
            ["profile:", `${shown.profile}${settings.profile in config.profiles ? "" : " (not in the config file)"}`],
            ["config file:", shown.configFile],
            ["server:", `${shown.server} (from ${shown.serverFrom})`],
            ["API key:", shown.apiKey === null ? "none" : `${shown.apiKey} (from ${shown.apiKeyFrom ?? ""})`],
            ...(shown.apiKeyId === null ? [] : [["API key id:", shown.apiKeyId]]),
            ...(shown.username === null ? [] : [["username:", shown.username]]),
          ],
          "",
        ),
      );
      return Promise.resolve();
    },
  },

  profiles: {
    synopsis: "",
    summary: "List the profiles, marking the current one",
    run: (context) => {
      const { config } = context;
      const current = currentProfileName(config);
      // With no profiles, the CLI behaves as if there were one: the default.
      const profiles: Record<string, Profile> = Object.keys(config.profiles).length === 0 ? { [DEFAULT_PROFILE]: {} } : { ...config.profiles };
      const list = Object.entries(profiles).map(([name, profile]) => ({ name, current: name === current, ...maskedProfile(profile) }));
      emit(context, { currentProfile: current, profiles: list }, () =>
        table(
          [
            [" ", "Profile", "Server", "Username", "API key"],
            ...list.map((p) => [p.current ? "*" : " ", p.name, p.server ?? `${DEFAULT_SERVER} (default)`, p.username ?? "", p.apiKey ?? ""]),
          ],
          "",
        ),
      );
      return Promise.resolve();
    },
  },

  use: {
    synopsis: "PROFILE",
    summary: "Make PROFILE current, creating it if missing",
    args: ["PROFILE"],
    run: async (context, [name = ""]) => {
      checkProfileName(name);
      const created = !(name in context.config.profiles);
      const config = created ? withProfile(context.config, name, {}) : context.config;
      await context.saveConfig({ ...config, currentProfile: name });
      emit(context, {}, () => [`Now using profile ${name}${created ? ` (new: server ${DEFAULT_SERVER} until 'aumohta config set server URL')` : ""}.`]);
    },
  },

  set: {
    synopsis: "server URL",
    summary: "Set the current profile's server",
    args: ["SETTING", "VALUE"],
    run: async (context, [setting = "", value = ""]) => {
      if (setting !== "server") throw usageError(`only "server" can be set, got "${setting}"`);
      const server = checkServerUrl(value);
      const { profile } = context.settings;
      const stored = context.config.profiles[profile] ?? {};
      await context.saveConfig(withProfile(context.config, profile, { ...stored, server }));
      if (stored.apiKey !== undefined && stored.server !== undefined && stored.server !== server) {
        context.io.err(`Note: profile ${profile}'s API key was created on ${stored.server}; log in again on ${server}.`);
      }
      emit(context, {}, () => [`Profile ${profile} now uses server ${server}.`]);
    },
  },

  remove: {
    synopsis: "PROFILE",
    summary: "Delete a profile (does not revoke its key; 'auth logout' does)",
    args: ["PROFILE"],
    run: async (context, [name = ""]) => {
      const profile = context.config.profiles[name];
      if (profile === undefined) throw new CliError(EXIT.refused, "config", `there is no profile "${name}" in ${context.configPath}`);
      const { currentProfile, ...rest } = withProfile(context.config, name, undefined);
      await context.saveConfig(currentProfile === name || currentProfile === undefined ? rest : { ...rest, currentProfile });
      emit(context, {}, () => [
        `Removed profile ${name}.`,
        ...(profile.apiKey === undefined ? [] : [`Its API key ${profile.apiKeyId ?? maskKey(profile.apiKey)} still works; revoke it with 'aumohta keys revoke KEY_ID'.`]),
      ]);
    },
  },
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export const apiCommand: Command = {
  synopsis: "METHOD PATH [--body FILE] [--query KEY=VALUE ...]",
  summary: "Send one request with the profile's server and credentials, and print the response body",
  args: ["METHOD", "PATH"],
  options: { body: { type: "string" }, query: { type: "string", multiple: true } },
  run: async (context, [methodText = "", path = ""], values) => {
    const method = methodText.toUpperCase();
    if (!METHODS.includes(method)) throw usageError(`METHOD must be one of ${METHODS.join(", ")}, got "${methodText}"`);
    if (!path.startsWith("/")) throw usageError(`PATH must start with "/", got "${path}"`);
    const query = strs(values, "query").map((pair): [string, string] => {
      const at = pair.indexOf("=");
      if (at < 1) throw usageError(`--query needs KEY=VALUE, got "${pair}"`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    });
    const bodyFile = str(values, "body");
    let body: unknown;
    if (bodyFile !== undefined) {
      const text = await readInput(context, bodyFile, "--body");
      try {
        body = JSON.parse(text);
      } catch (e) {
        throw inputError(`${bodyFile === "-" ? "stdin" : bodyFile} is not valid JSON: ${(e as Error).message}`);
      }
    }
    const response = await context.client.send(method, path, { query, ...(body === undefined ? {} : { body }) });
    if (response.text === "") context.io.out("{}");
    else if (response.contentType.startsWith("application/json")) context.io.out(JSON.stringify(parseJson(response.text, `${method} ${path}`), null, 2));
    else context.io.out(response.text.replace(/\n$/, ""));
  },
};

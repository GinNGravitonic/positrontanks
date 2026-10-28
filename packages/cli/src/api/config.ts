/**
 * The config file of the server commands (docs/spec/cli-api.md,
 * Configuration): named profiles, each a server URL and optionally an API
 * key, and which profile is current.
 *
 * The file is `$XDG_CONFIG_HOME/aumohta/config.json` (default
 * `~/.config/aumohta/config.json`), or `%APPDATA%\aumohta\config.json` on
 * Windows, written with mode 0600 since it holds API keys. Each setting is
 * taken from the first of an option, the environment, the chosen profile
 * and the built-in default (`resolveSettings`).
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT, usageError } from "./client.js";

export interface Profile {
  readonly server?: string;
  readonly apiKey?: string;
  readonly apiKeyId?: string;
  readonly username?: string;
}

export interface Config {
  readonly currentProfile?: string;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_PROFILE = "default";
/** The Docker image's default port (docs/docker.md). */
export const DEFAULT_SERVER = "http://localhost:8080";

const configError = (message: string): CliError => new CliError(EXIT.refused, "config", message);

export function configPath(env: Env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "aumohta", "config.json");
  const base = env.XDG_CONFIG_HOME;
  return join(base !== undefined && base !== "" ? base : join(home, ".config"), "aumohta", "config.json");
}

const PROFILE_FIELDS: readonly (keyof Profile)[] = ["server", "apiKey", "apiKeyId", "username"];

/** Reads the config file; a missing file is an empty config. */
export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw configError(`cannot read ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw configError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const bad = (what: string) => configError(`${path}: ${what}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("must be a JSON object");
  const { currentProfile, profiles = {} } = raw as { currentProfile?: unknown; profiles?: unknown };
  if (currentProfile !== undefined && typeof currentProfile !== "string") throw bad("currentProfile must be a string");
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) throw bad("profiles must be an object");
  for (const [name, profile] of Object.entries(profiles)) {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw bad(`profile "${name}" must be an object`);
    for (const field of PROFILE_FIELDS) {
      const value = (profile as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "string") throw bad(`profile "${name}": ${field} must be a string`);
    }
  }
  return { ...(currentProfile === undefined ? {} : { currentProfile }), profiles: profiles as Record<string, Profile> };
}

/** Writes the config file, readable only by its owner where the platform has modes. */
export async function writeConfig(path: string, config: Config): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    // Written beside the file and renamed over it, so a failed write never loses the profiles.
    const temporary = `${path}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (e) {
    throw configError(`cannot write ${path}: ${(e as Error).message}`);
  }
}

const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function checkProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) throw usageError(`profile names are 1 to 64 letters, digits, '.', '-' or '_', got "${name}"`);
  return name;
}

export function checkServerUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError(`the server must be an http or https URL, got "${text}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw usageError(`the server must be an http or https URL, got "${text}"`);
  return text.replace(/\/+$/, "");
}

export const currentProfileName = (config: Config): string => config.currentProfile ?? DEFAULT_PROFILE;

/** Where a setting came from. */
export type Source = "option" | "environment" | "profile" | "default";

/** The settings a server command runs with. */
export interface Settings {
  readonly profile: string;
  readonly server: string;
  readonly serverSource: Source;
  readonly apiKey: string | undefined;
  readonly apiKeySource: Source | undefined;
}

export interface SettingOptions {
  readonly server?: string;
  readonly profile?: string;
  /** Read with `--api-key-stdin`. */
  readonly apiKey?: string;
}

/** Each setting from the first of the options, the environment, the chosen profile and the default. */
export function resolveSettings(config: Config, env: Env, options: SettingOptions): Settings {
  const set = (value: string | undefined): value is string => value !== undefined && value !== "";
  const profile = checkProfileName(options.profile ?? (set(env.AUMOHTA_PROFILE) ? env.AUMOHTA_PROFILE : currentProfileName(config)));
  const stored = config.profiles[profile] ?? {};
  const pick = (option: string | undefined, envValue: string | undefined, profileValue: string | undefined): [string, Source] | undefined =>
    set(option) ? [option, "option"] : set(envValue) ? [envValue, "environment"] : set(profileValue) ? [profileValue, "profile"] : undefined;
  const [server, serverSource] = pick(options.server, env.AUMOHTA_SERVER, stored.server) ?? [DEFAULT_SERVER, "default"];
  const key = pick(options.apiKey, env.AUMOHTA_API_KEY, stored.apiKey);
  return { profile, server: checkServerUrl(server), serverSource, apiKey: key?.[0], apiKeySource: key?.[1] };
}

/** The config with one profile replaced (or removed, for `undefined`). */
export function withProfile(config: Config, name: string, profile: Profile | undefined): Config {
  const others = Object.entries(config.profiles).filter(([other]) => other !== name);
  return { ...config, profiles: Object.fromEntries(profile === undefined ? others : [...others, [name, profile]]) };
}

/** The visible start of an API key, as the server's `prefix` shows it. */
export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 12)}...` : "***";
}

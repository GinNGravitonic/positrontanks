/**
 * What every server command shares (docs/spec/cli-api.md): the command
 * shape, the settings and client a command runs with, reading secrets and
 * stdin, and the human and JSON output.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { Io } from "../cli.js";
import { ApiClient, CliError, EXIT, inputError, usageError, type PageOptions, type Schema } from "./client.js";
import { writeConfig, type Config, type Env, type Settings } from "./config.js";

export type OptionSpec = { readonly type: "string"; readonly multiple?: boolean } | { readonly type: "boolean" };
export type Values = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

/** One command of a group, such as `auth login`. */
export interface Command {
  /** The arguments and options after the group and verb, for help: `USERNAME [--password-stdin]`. */
  readonly synopsis: string;
  readonly summary: string;
  /** The positional arguments' names; a name in brackets is optional. */
  readonly args?: readonly string[];
  readonly options?: Readonly<Record<string, OptionSpec>>;
  run(context: Context, args: readonly string[], values: Values): Promise<void>;
}

export type Group = Readonly<Record<string, Command>>;

export interface Context {
  readonly io: Io;
  readonly env: Env;
  readonly json: boolean;
  readonly configPath: string;
  readonly config: Config;
  readonly settings: Settings;
  /** A client for the settings' server and API key. */
  readonly client: ApiClient;
  /** Reads all of stdin for `option`; only one option of a command may read it. */
  readonly readStdin: (option: string) => Promise<string>;
  readonly saveConfig: (config: Config) => Promise<void>;
}

/** Reads all of stdin for an option, refusing a second option: stdin can be read only once. */
export function stdinReader(io: Io): (option: string) => Promise<string> {
  let reader: string | undefined;
  return (option) => {
    if (reader !== undefined) return Promise.reject(usageError(`${reader} and ${option} cannot both read stdin`));
    reader = option;
    if (io.readStdin === undefined) return Promise.reject(usageError(`${option}: there is no stdin to read`));
    return io.readStdin();
  };
}

export function createContext(
  io: Io,
  env: Env,
  json: boolean,
  configPath: string,
  config: Config,
  settings: Settings,
  readStdin: (option: string) => Promise<string>,
): Context {
  return {
    io,
    env,
    json,
    configPath,
    config,
    settings,
    client: new ApiClient(settings.server, settings.apiKey),
    readStdin,
    saveConfig: (next) => writeConfig(configPath, next),
  };
}

export const str = (values: Values, name: string): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};
export const flag = (values: Values, name: string): boolean => values[name] === true;
export const strs = (values: Values, name: string): string[] => {
  const value = values[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
};

/** The text options given, by name, for a request body; those left out are left out. */
export function textOptions(values: Values, ...names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = str(values, name);
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}

/** Drops the line break a pipe or here-string leaves at the end of a secret. */
const chomp = (text: string): string => text.replace(/\r?\n$/, "");

/**
 * A secret from stdin when `fromStdin`, else asked on the terminal without
 * echo. Never an option: it would show in the process list and shell history.
 */
export async function readSecret(context: Context, fromStdin: boolean, option: string, prompt: string): Promise<string> {
  let secret: string;
  if (fromStdin) secret = chomp(await context.readStdin(option));
  else if (context.io.askSecret !== undefined) secret = await context.io.askSecret(prompt);
  else throw usageError(`there is no terminal to ask on; give it with ${option}`);
  if (secret === "") throw inputError(`${option === "--password-stdin" ? "the password" : "the API key"} is empty`);
  return secret;
}

/** A local file, or stdin for `-`; an unreadable file is an `input` error (exit code 1). */
export async function readInput(context: Context, path: string, option: string): Promise<string> {
  if (path === "-") return context.readStdin(option);
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    throw inputError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

/** A local JSON file, or stdin for `-`; malformed JSON is an `input` error. */
export async function readJsonInput(context: Context, path: string, option: string): Promise<unknown> {
  const text = await readInput(context, path, option);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw inputError(`${path === "-" ? "stdin" : path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Writes a file for an `--out`-like option; a failure is an `input` error (exit code 1). */
export async function writeOutput(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text);
  } catch (e) {
    throw inputError(`cannot write ${path}: ${(e as Error).message}`);
  }
}

/** A whole-number argument or option, at least `min`; anything else is a usage error. */
export function wholeNumber(name: string, text: string, min = 1): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n) || n < min) throw usageError(`${name} needs a whole number of at least ${String(min)}, got "${text}"`);
  return n;
}

/** wholeNumber for an option that may be left out. */
export function optionalNumber(values: Values, name: string, min = 1): number | undefined {
  const text = str(values, name);
  return text === undefined ? undefined : wholeNumber(`--${name}`, text, min);
}

/** The Ruleset version given, else the latest the server hosts (the last of `GET /rulesets`). */
export async function rulesetOrLatest(context: Context, given: string | undefined): Promise<string> {
  if (given !== undefined) return given;
  const { rulesets } = await context.client.request<Schema<"RulesetList">>("GET", "/rulesets");
  const latest = rulesets[rulesets.length - 1];
  if (latest === undefined) throw new CliError(EXIT.server, "bad_response", "the server hosts no Ruleset");
  return latest.version;
}

/**
 * Runs `send`, and in human output shows the Program's problems at `file`
 * (`hunter.ptk:12:5`, as the local runner does) instead of at `program`.
 * JSON output keeps the server's error body as is.
 */
export async function withProgramFile<T>(context: Context, file: string | undefined, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (context.json || file === undefined || file === "-" || !(e instanceof CliError) || e.details === undefined) throw e;
    throw new CliError(e.exitCode, e.code, e.message, e.details.map((d) => (d.path === "program" ? { ...d, path: file } : d)));
  }
}

/** Prints the body as JSON in JSON mode, else the human lines. */
export function emit(context: Context, body: unknown, human: () => readonly string[]): void {
  if (context.json) context.io.out(JSON.stringify(body, null, 2));
  else for (const line of human()) context.io.out(line);
}

/** Options of every list command (docs/spec/cli-api.md, Paging). */
export const PAGE_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  limit: { type: "string" },
  cursor: { type: "string" },
  all: { type: "boolean" },
};

export function pageOptions(values: Values): PageOptions {
  const limitText = str(values, "limit");
  const cursor = str(values, "cursor");
  const all = flag(values, "all");
  let limit: number | undefined;
  if (limitText !== undefined) {
    limit = Number(limitText);
    if (limitText.trim() === "" || !Number.isInteger(limit) || limit < 1) throw usageError(`--limit needs a whole number of at least 1, got "${limitText}"`);
  }
  return { all, ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}

/** In human output, the hint after a list with more pages. */
export function moreHint(context: Context, nextCursor: string | null): void {
  if (!context.json && nextCursor !== null) context.io.err(`More: --cursor ${nextCursor} (or --all)`);
}

/** A time for people: how long ago, or the date. */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (minutes < 24 * 60) return `${String(Math.floor(minutes / 60))} h ago`;
  if (minutes < 30 * 24 * 60) return `${String(Math.floor(minutes / (24 * 60)))} days ago`;
  return new Date(then).toLocaleDateString();
}

/** A path segment from an id, so an id can never change the endpoint. */
export const segment = (id: string): string => encodeURIComponent(id);

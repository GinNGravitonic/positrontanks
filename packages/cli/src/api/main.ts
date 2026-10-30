/**
 * The server commands' dispatch (docs/spec/cli-api.md): `positrontanks <group>
 * <command> [arguments] [options]`, plus `positrontanks api METHOD PATH`.
 *
 * Every command takes the global options `--server URL`, `--profile NAME`,
 * `--api-key-stdin` and `--json`. Errors go to stderr in the error format,
 * and the exit code says what kind of failure it was (client.ts, EXIT).
 */

import { parseArgs } from "node:util";
import type { Io } from "../cli.js";
import { authCommands, keysCommands } from "./accounts.js";
import { CliError, EXIT, inputError, usageError } from "./client.js";
import { configPath, readConfig, resolveSettings } from "./config.js";
import { createContext, flag, stdinReader, str, type Command, type Group, type OptionSpec } from "./context.js";
import { designsCommands } from "./designs.js";
import { gamesCommands } from "./games.js";
import { mapsCommands } from "./maps.js";
import { rulesetsCommands } from "./rulesets.js";
import { apiCommand, configCommands, serverCommands } from "./system.js";
import { remoteTickCostCommand } from "./tick-cost-remote.js";

const GROUPS: Readonly<Record<string, Group>> = {
  server: serverCommands,
  auth: authCommands,
  keys: keysCommands,
  rulesets: rulesetsCommands,
  designs: designsCommands,
  maps: mapsCommands,
  games: gamesCommands,
  config: configCommands,
};

/** The first words that run a server command. */
export const SERVER_COMMANDS: readonly string[] = [...Object.keys(GROUPS), "api"];

const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec & { short?: string }>> = {
  server: { type: "string" },
  profile: { type: "string" },
  "api-key-stdin": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const GLOBAL_HELP = `Global options (any server command):
  --server URL          The server (env POSITRONTANKS_SERVER; default: the profile's,
                        else http://localhost:8080)
  --profile NAME        The profile in the config file (env POSITRONTANKS_PROFILE;
                        default: the current profile)
  --api-key-stdin       Read the API key from stdin (env POSITRONTANKS_API_KEY;
                        default: the profile's)
  --json                Print the server's JSON response body (env
                        POSITRONTANKS_OUTPUT=json); errors go to stderr as JSON
  -h, --help            Show this help

Exit codes: 0 success, 1 refused (4xx or a bad input file), 2 bad usage,
3 not authenticated, 4 server or network failure (worth retrying).`;

function commandLines(prefix: string, commands: Readonly<Record<string, Command>>): string[] {
  return Object.entries(commands).map(([verb, c]) => `  positrontanks ${prefix}${verb}${c.synopsis === "" ? "" : ` ${c.synopsis}`}\n      ${c.summary}`);
}

/** Help for one group, or for every server command. */
export function serverUsage(group?: string): string {
  const groups = group === undefined ? Object.keys(GROUPS) : [group];
  const lines = groups.flatMap((g) => (g === "api" ? commandLines("", { api: apiCommand }) : commandLines(`${g} `, GROUPS[g] ?? {})));
  if (group === undefined) lines.push(...commandLines("", { api: apiCommand, "tick-cost": remoteTickCostCommand }));
  return `Server commands (talk to a Positron Tanks server over its HTTP API):\n${lines.join("\n")}\n\n${GLOBAL_HELP}`;
}

/** Runs `positrontanks <group> ...`, where `group` is one of SERVER_COMMANDS, and returns the exit code. */
export async function serverMain(group: string, argv: readonly string[], io: Io): Promise<number> {
  if (group === "api") return runCommand(apiCommand, "api", argv, io, group);
  const [verb, ...rest] = argv;
  const commands = GROUPS[group] ?? {};
  if (verb === "-h" || verb === "--help") {
    io.out(serverUsage(group));
    return EXIT.ok;
  }
  const command = verb === undefined ? undefined : commands[verb];
  const problem =
    verb === undefined
      ? `'positrontanks ${group}' needs a command: ${Object.keys(commands).join(", ")}`
      : `unknown command "${group} ${verb}"; one of: ${Object.keys(commands).join(", ")}`;
  return runCommand(command ?? problem, `${group} ${verb ?? ""}`, rest, io, group);
}

/** Runs `positrontanks tick-cost --remote ...`, the tick cost check on the server, and returns the exit code. */
export function remoteTickCost(argv: readonly string[], io: Io): Promise<number> {
  return runCommand(remoteTickCostCommand, "tick-cost", argv, io, "tick-cost");
}

/** Runs one command (or reports `command`, a usage problem found before it) and returns the exit code. */
async function runCommand(command: Command | string, name: string, argv: readonly string[], io: Io, group: string): Promise<number> {
  const env = io.env ?? process.env;
  // Known before parsing, so even a usage error is printed in JSON.
  let json = argv.includes("--json") || env.POSITRONTANKS_OUTPUT === "json";
  try {
    if (typeof command === "string") throw usageError(command);
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: { ...GLOBAL_OPTIONS, ...command.options } });
    } catch (e) {
      throw usageError((e as Error).message);
    }
    const values = parsed.values as Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
    json ||= flag(values, "json");
    if (flag(values, "help")) {
      io.out(`Usage: positrontanks ${name}${command.synopsis === "" ? "" : ` ${command.synopsis}`}
  ${command.summary}

${GLOBAL_HELP}`);
      return EXIT.ok;
    }
    const names = command.args ?? [];
    const required = names.filter((n) => !n.startsWith("[")).length;
    if (parsed.positionals.length < required) throw usageError(`'positrontanks ${name}' needs ${names.join(" ")}`);
    if (parsed.positionals.length > names.length) throw usageError(`unexpected argument "${parsed.positionals[names.length] ?? ""}" for 'positrontanks ${name}'`);

    const path = configPath(env);
    const config = await readConfig(path);
    const readStdin = stdinReader(io);
    let apiKey: string | undefined;
    if (flag(values, "api-key-stdin")) {
      apiKey = (await readStdin("--api-key-stdin")).trim();
      if (apiKey === "") throw inputError("the API key on stdin is empty");
    }
    const settings = resolveSettings(config, env, { server: str(values, "server"), profile: str(values, "profile"), apiKey });
    await command.run(createContext(io, env, json, path, config, settings, readStdin), parsed.positionals, values);
    return EXIT.ok;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    printError(io, json, e, group);
    return e.exitCode;
  }
}

function printError(io: Io, json: boolean, error: CliError, group: string): void {
  if (json) {
    io.err(JSON.stringify(error.body, null, 2));
    return;
  }
  io.err(`positrontanks: ${error.code}: ${error.message}`);
  for (const d of error.details ?? []) io.err(`  ${d.path}${d.line === undefined ? "" : `:${String(d.line)}:${String(d.column ?? 1)}`}: ${d.message}`);
  if (error.code === "usage") io.err(`Run 'positrontanks ${group} --help' for usage.`);
}

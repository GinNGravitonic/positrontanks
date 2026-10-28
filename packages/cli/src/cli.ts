/**
 * The `aumohta` command line (v1.md section 10).
 *
 * `aumohta run --map FILE --entry FILE ... [--unthrottled]` plays a Game
 * locally with no account, server or database, prints its result and each
 * Program's per-Tick budget peaks, and writes the Game Record, Replay and
 * Program logs.
 *
 * `aumohta tick-cost --entry FILE [--ticks N] [--seed N] [--json]` runs the
 * tick cost check offline: each of the Entry file's Bots in the sample world,
 * reporting what the server's tick cost endpoints report. With `--remote` it
 * runs on a server instead (api/tick-cost-remote.ts).
 *
 * `aumohta <group> <command> ...` and `aumohta api METHOD PATH` talk to an
 * Aumohta server over its HTTP API (docs/spec/cli-api.md; api/main.ts).
 */

import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { TICK_COST_DEFAULT_SEED, TICK_COST_DEFAULT_TICKS, TICK_COST_MAX_TICKS } from "@aumohta/engine-r1";
import { RULESET_VERSIONS, type RulesetVersion } from "@aumohta/ruleset-data/rulesets";
import { inputError } from "./api/client.js";
import { remoteTickCost, SERVER_COMMANDS, serverMain, serverUsage } from "./api/main.js";
import { InputError } from "./entry-file.js";
import { budgetPeaks, formatBudgetPeaks, formatResult } from "./report.js";
import { loadGame, playLocalGame, SEED_LIMIT, startGame, writeOutputs, type PlayOptions } from "./run.js";
import { formatTickCosts, loadTickCostCheck, runTickCostCheck } from "./tick-cost.js";

/** Where the CLI writes, and what the server commands read besides their arguments; tests replace them. */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The environment; process.env when left out. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Reads all of stdin. */
  readonly readStdin?: () => Promise<string>;
  /** Asks for a secret on the terminal without echo; left out when there is no terminal. */
  readonly askSecret?: (prompt: string) => Promise<string>;
  /** Waits `ms` milliseconds (`games watch`'s backoff and polling); a timer when left out. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
  ...(process.stdin.isTTY ? { askSecret } : {}),
};

/** Reads one line from the terminal in raw mode, echoing nothing. */
function askSecret(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error === undefined) resolve(secret);
      else reject(error);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish(inputError("cancelled"));
          return;
        }
        secret = ch === "\u007f" || ch === "\b" ? secret.slice(0, -1) : secret + ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** The latest Ruleset this CLI supports (docs/spec/cli-runner.md). */
export const DEFAULT_RULESET: RulesetVersion = RULESET_VERSIONS[RULESET_VERSIONS.length - 1] ?? RULESET_VERSIONS[0];
/** Must stay at or below the server's default maximum time limit (checked in packages/server/src/config.test.ts; docs/spec/cli-runner.md). */
export const DEFAULT_TIME_LIMIT_SECONDS = 120;

export const USAGE = `Usage: aumohta run --map FILE --entry FILE [--entry FILE ...] [options]
       aumohta tick-cost --entry FILE [--ticks N] [--seed N] [--json]

Plays a Game locally, with no account, server or database. Prints the result
and each Program's per-Tick budget peaks, and writes game-record.json,
replay.json and program-logs.json into the output directory.

Options:
  --map FILE            The Map (Map Format JSON)
  --entry FILE          An Entry file (JSON); give one per Entry, in Entry order
  --unthrottled         Play as fast as possible (default: real time, one
                        simulated second per real second)
  --seed N              The Game seed, a whole number in [0, 2^32)
                        (default: random; printed so the Game can be repeated)
  --time-limit SECONDS  The time limit in simulated seconds, a whole number
                        of at least 1, as on the server (default: ${String(DEFAULT_TIME_LIMIT_SECONDS)})
  --point-budget N      The Point Budget (default: the Ruleset's maximum)
  --ruleset VERSION     The Ruleset version (default: ${DEFAULT_RULESET}, the latest)
  --out DIR             Where to write the output files (default: .)
  --json                Print a JSON summary instead of text
  -h, --help            Show this help

Entry file:
  {
    "ruleset": "r1",                       (optional; must match --ruleset)
    "player": "alice",                     (optional; default: file name
                                            without .json and .entry)
    "bots": [
      { "name": "Pecker",                  (the Bot Name, unique in the Game)
        "build": { "chassis": "scout", "components": { "gun": "pelletGun" },
                   "armor": { "front": null, "left": null, "right": null, "rear": null } },
        "programFile": "hunter.aum" }      (relative to the Entry file; or
                                            "program": "<inline source>")
    ]
  }

aumohta tick-cost runs the tick cost check offline: each Bot of the Entry
file runs its init phase and then tick() for N Ticks in the sample world, as
the server's tick cost endpoints do, and the report gives the operations each
run used, the peak and persistent memory.

Options:
  --entry FILE          An Entry file (JSON), as for run; its ruleset defaults
                        to ${DEFAULT_RULESET}
  --ticks N             Ticks to run, 1 to ${String(TICK_COST_MAX_TICKS)} (default: ${String(TICK_COST_DEFAULT_TICKS)})
  --seed N              The sample Game's seed, a whole number in [0, 2^32)
                        (default: ${String(TICK_COST_DEFAULT_SEED)})
  --json                Print each Bot's report as JSON, as the server does
  --remote              Run the check on the server (POST /tick-cost-checks),
                        which needs AUMOHTA_TICK_COST_CHECK=on there; takes the
                        server commands' global options below
  -h, --help            Show this help

${serverUsage()}`;

class UsageError extends Error {}

function parseNumber(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v)) throw new UsageError(`${flag} needs a number, got "${text}"`);
  return v;
}

/** The server takes the time limit as a whole number of seconds, at least 1; so does the CLI, so any local Game can be repeated there. */
function parseTimeLimit(text: string | undefined): number {
  const seconds = parseNumber("--time-limit", text) ?? DEFAULT_TIME_LIMIT_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1) throw new InputError(`--time-limit must be a whole number of seconds, at least 1, got ${String(seconds)}`);
  return seconds;
}

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export async function main(argv: readonly string[], io: Io = processIo, play: Partial<PlayOptions> = {}): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === "-h" || command === "--help" || command === "help") {
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (command === "tick-cost") return await tickCost(rest, io);
    if (SERVER_COMMANDS.includes(command)) return await serverMain(command, rest, io);
    if (command !== "run") throw new UsageError(`unknown command "${command}"`);
    return await run(rest, io, play);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`aumohta: ${e.message}`);
      io.err("Run 'aumohta --help' for usage.");
      return 2;
    }
    io.err(`aumohta: ${e instanceof InputError ? "" : "error: "}${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function run(argv: readonly string[], io: Io, play: Partial<PlayOptions>): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        map: { type: "string" },
        entry: { type: "string", multiple: true },
        unthrottled: { type: "boolean", default: false },
        seed: { type: "string" },
        "time-limit": { type: "string" },
        "point-budget": { type: "string" },
        ruleset: { type: "string", default: DEFAULT_RULESET },
        out: { type: "string", default: "." },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (values.map === undefined) throw new UsageError("--map is required");
  const entryPaths = values.entry ?? [];
  if (entryPaths.length === 0) throw new UsageError("at least one --entry is required");

  const seed = parseNumber("--seed", values.seed) ?? randomInt(0, SEED_LIMIT);
  const pointBudget = parseNumber("--point-budget", values["point-budget"]);
  const loaded = await loadGame({
    mapPath: values.map,
    entryPaths,
    ruleset: values.ruleset,
    seed,
    timeLimitSeconds: parseTimeLimit(values["time-limit"]),
    ...(pointBudget === undefined ? {} : { pointBudget }),
  });
  const { setup } = loaded;
  const { tickRate } = setup.ruleset;
  const text = !values.json;
  if (text) {
    const players = setup.entries.map((e, i) => `${e.player ?? ""} (${String(loaded.costs[i])} pts)`).join(", ");
    io.out(`Ruleset ${setup.ruleset.version}, Map ${values.map}, seed ${String(seed)}`);
    io.out(`Entries: ${players}; Point Budget ${String(loaded.pointBudget)}`);
    io.out(`Time limit ${String(setup.timeLimitTicks / tickRate)} s (${String(setup.timeLimitTicks)} Ticks), ${values.unthrottled ? "unthrottled" : "real time"}`);
  }

  const game = startGame(loaded);
  const name = (id: number) => game.world.bots[id - 1]?.name ?? `#${String(id)}`;
  const announce = (events: readonly { type: string; tick: number; bot?: number; cause?: string }[]) => {
    for (const e of events) if (e.type === "disabled" && e.bot !== undefined) io.out(`Tick ${String(e.tick)}: ${name(e.bot)} Disabled (${e.cause ?? ""})`);
  };
  if (text) announce(game.start.events);
  const result = await playLocalGame(game, {
    ...play,
    unthrottled: values.unthrottled,
    onTick: (report, g) => {
      if (text) announce(report.events);
      play.onTick?.(report, g);
    },
  });
  const files = await writeOutputs(game, values.out);
  const peaks = budgetPeaks(game);

  if (text) {
    io.out("");
    for (const line of formatResult(result, tickRate)) io.out(line);
    io.out("");
    for (const line of formatBudgetPeaks(peaks)) io.out(line);
    io.out("");
    io.out(`Game Record:  ${files.record}`);
    io.out(`Replay:       ${files.replay}`);
    io.out(`Program logs: ${files.programLogs}`);
  } else {
    io.out(
      JSON.stringify(
        { ruleset: setup.ruleset.version, seed, timeLimitTicks: setup.timeLimitTicks, pointBudget: loaded.pointBudget, costs: loaded.costs, result, budgetPeaks: peaks, files },
        null,
        2,
      ),
    );
  }
  return 0;
}

async function tickCost(argv: readonly string[], io: Io): Promise<number> {
  // With --remote the check runs on the server, as a server command (api/tick-cost-remote.ts).
  if (argv.includes("--remote")) return remoteTickCost(argv, io);
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        entry: { type: "string" },
        ticks: { type: "string" },
        seed: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (values.entry === undefined) throw new UsageError("--entry is required");

  const loaded = await loadTickCostCheck({
    entryPath: values.entry,
    defaultRuleset: DEFAULT_RULESET,
    ticks: parseNumber("--ticks", values.ticks) ?? TICK_COST_DEFAULT_TICKS,
    seed: parseNumber("--seed", values.seed) ?? TICK_COST_DEFAULT_SEED,
  });
  const costs = runTickCostCheck(loaded);
  if (values.json) {
    io.out(JSON.stringify({ player: loaded.player, bots: costs }, null, 2));
    return 0;
  }
  const { ticks, seed } = loaded.options;
  io.out(`Ruleset ${loaded.ruleset.version}, Entry ${values.entry} (${loaded.player}), seed ${String(seed)}, ${String(ticks)} Ticks in the sample world`);
  io.out("");
  for (const line of formatTickCosts(costs)) io.out(line);
  return 0;
}

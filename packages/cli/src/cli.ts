/**
 * The `aumohta` command line (v1.md section 10).
 *
 * `aumohta run --map FILE --entry FILE ... [--unthrottled]` plays a Game
 * locally with no account, server or database, prints its result and each
 * Program's per-Tick budget peaks, and writes the Game Record, Replay and
 * Program logs.
 */

import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { InputError } from "./entry-file.js";
import { budgetPeaks, formatBudgetPeaks, formatResult } from "./report.js";
import { loadGame, playLocalGame, SEED_LIMIT, startGame, writeOutputs, type PlayOptions } from "./run.js";

/** Where the CLI writes; tests capture it. */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const DEFAULT_RULESET = "r1";
/** Must stay at or below the server's default maximum time limit (checked in packages/server/src/config.test.ts; docs/spec/cli-runner.md). */
export const DEFAULT_TIME_LIMIT_SECONDS = 120;

export const USAGE = `Usage: aumohta run --map FILE --entry FILE [--entry FILE ...] [options]

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
  --time-limit SECONDS  The time limit in simulated seconds (default: ${String(DEFAULT_TIME_LIMIT_SECONDS)})
  --point-budget N      The Point Budget (default: the Ruleset's maximum)
  --ruleset VERSION     The Ruleset version (default: ${DEFAULT_RULESET})
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
  }`;

class UsageError extends Error {}

function parseNumber(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v)) throw new UsageError(`${flag} needs a number, got "${text}"`);
  return v;
}

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export async function main(argv: readonly string[], io: Io = processIo, play: Partial<PlayOptions> = {}): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === "-h" || command === "--help" || command === "help") {
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    }
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
    timeLimitSeconds: parseNumber("--time-limit", values["time-limit"]) ?? DEFAULT_TIME_LIMIT_SECONDS,
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

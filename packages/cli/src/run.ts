/**
 * Running a Game locally from files, with no server or database (v1.md
 * section 10, CLI runner).
 *
 * `loadGame` reads the Map and Entry files and checks them as the server
 * would on submission: the Map against the Ruleset, each Build and Program,
 * each Entry's cost against the Point Budget and its size against the Map's
 * Spawn Zones, and Bot Names unique within the Game. `playLocalGame` plays
 * the Game at the chosen Pace, and `writeOutputs` writes its Game Record,
 * Replay and Program logs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, R1_LANGUAGE } from "@positrontanks/language";
import {
  createGame,
  deriveBotSpec,
  gameRecord,
  playTick,
  programSlots,
  replayOf,
  type Game,
  type GameResult,
  type GameSetup,
  type TickReport,
} from "@positrontanks/engine-r1";
import { checkMapTerrains, entryFitsMap, parseMap, terrainNames, validateBuild, type MapFormat1, type Ruleset } from "@positrontanks/ruleset-data";
import { isRulesetVersion, loadRuleset, RULESET_VERSIONS } from "@positrontanks/ruleset-data/rulesets";
import { InputError, readEntryFile, readText, type EntryFile, type ValidBot } from "./entry-file.js";

export interface GameOptions {
  readonly mapPath: string;
  readonly entryPaths: readonly string[];
  /** The Ruleset version. */
  readonly ruleset: string;
  readonly seed: number;
  /** In simulated seconds; a whole number, at least 1, as on the server. */
  readonly timeLimitSeconds: number;
  /** Defaults to the Ruleset's maximum. */
  readonly pointBudget?: number;
}

/** A Game checked and ready to play. */
export interface LoadedGame {
  readonly setup: GameSetup;
  readonly pointBudget: number;
  /** Each Entry's point cost, in Entry order. */
  readonly costs: readonly number[];
}

/** The largest seed the engine accepts, plus one. */
export const SEED_LIMIT = 2 ** 32;

/** Reads and checks every input file. Throws InputError listing every problem found. */
export async function loadGame(options: GameOptions): Promise<LoadedGame> {
  const ruleset = rulesetFor(options.ruleset);
  const { seed, timeLimitSeconds } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw new InputError(`the seed must be a whole number in [0, 2^32), got ${String(seed)}`);
  if (!Number.isInteger(timeLimitSeconds) || timeLimitSeconds < 1) throw new InputError(`the time limit must be a whole number of seconds, at least 1, got ${String(timeLimitSeconds)}`);
  const timeLimitTicks = timeLimitSeconds * ruleset.tickRate;
  const { min, max } = ruleset.pointBudget;
  const pointBudget = options.pointBudget ?? max;
  if (!Number.isFinite(pointBudget) || pointBudget < min || pointBudget > max) {
    throw new InputError(`the Point Budget must be within Ruleset ${ruleset.version}'s range ${String(min)} to ${String(max)}, got ${String(pointBudget)}`);
  }

  const map = await loadMap(options.mapPath, ruleset);
  if (options.entryPaths.length === 0) throw new InputError("a Game needs at least one Entry");
  if (options.entryPaths.length > map.spawnZones.length) {
    throw new InputError(`the Map has ${String(map.spawnZones.length)} Spawn Zones, so at most ${String(map.spawnZones.length)} Entries, not ${String(options.entryPaths.length)}`);
  }
  const files = await Promise.all(options.entryPaths.map((p) => readEntryFile(p)));

  const errors: string[] = [];
  const names = new Map<string, string>();
  const entries: { file: EntryFile; bots: ValidBot[]; cost: number }[] = [];
  for (const file of files) {
    const fail = (message: string) => errors.push(`${file.path}: ${message}`);
    if (file.ruleset !== null && file.ruleset !== ruleset.version) fail(`the Entry is for Ruleset ${file.ruleset}, but the Game uses ${ruleset.version}`);
    if (!entryFitsMap(map, file.bots.length)) fail(`${String(file.bots.length)} Bots do not fit any of the Map's Spawn Zones`);
    let cost = 0;
    const bots: ValidBot[] = [];
    for (const bot of file.bots) {
      const where = `Bot "${bot.name}"`;
      const previous = names.get(bot.name);
      if (previous !== undefined) fail(`${where}: the Bot Name is already used in ${previous}; Bot Names must be unique within a Game`);
      names.set(bot.name, file.path);
      const validated = validateBuild(ruleset, bot.build);
      if (!validated.ok) {
        for (const e of validated.errors) fail(`${where}: ${e.path} ${e.message}`);
        continue;
      }
      cost += validated.cost;
      const checked = check(bot.program, {
        language: R1_LANGUAGE,
        maxSourceBytes: ruleset.limits.maxSourceBytes,
        slots: programSlots(deriveBotSpec(ruleset, validated.build)),
      });
      if (!checked.ok) {
        for (const e of checked.errors) errors.push(`${bot.programSource}:${String(e.line)}:${String(e.column)}: ${where}: ${e.message}`);
      }
      bots.push({ ...bot, build: validated.build });
    }
    if (cost > pointBudget) fail(`the Entry costs ${String(cost)} points, over the Point Budget of ${String(pointBudget)}`);
    entries.push({ file, bots, cost });
  }
  if (errors.length > 0) throw new InputError(errors.join("\n"));

  return {
    setup: {
      ruleset,
      map,
      seed,
      timeLimitTicks,
      entries: entries.map((e) => ({ player: e.file.player, bots: e.bots.map((b) => ({ name: b.name, build: b.build, program: b.program })) })),
    },
    pointBudget,
    costs: entries.map((e) => e.cost),
  };
}

function rulesetFor(version: string): Ruleset {
  if (!isRulesetVersion(version)) throw new InputError(`unknown Ruleset "${version}"; this CLI supports ${RULESET_VERSIONS.join(", ")}`);
  return loadRuleset(version);
}

async function loadMap(path: string, ruleset: Ruleset): Promise<MapFormat1> {
  const parsed = parseMap(await readText(path, "Map file"));
  if (!parsed.ok) throw new InputError(`${path}:\n${parsed.errors.map((e) => `  ${e.path} ${e.message}`).join("\n")}`);
  const { map } = parsed;
  if (!ruleset.mapFormats.includes(map.format)) throw new InputError(`${path}: Ruleset ${ruleset.version} does not support Map Format ${String(map.format)}`);
  const terrainErrors = checkMapTerrains(map, terrainNames(ruleset));
  if (terrainErrors.length > 0) throw new InputError(`${path}:\n${terrainErrors.map((e) => `  ${e.path} ${e.message}`).join("\n")}`);
  return map;
}

export interface PlayOptions {
  /** Play as fast as possible instead of one simulated second per real second. */
  readonly unthrottled: boolean;
  /** Called after each Tick, from Tick 1. */
  readonly onTick?: (report: TickReport, game: Game) => void;
  /** For tests: the clock and the wait used to keep real-time Pace. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

/** Plays the Game to its end at the chosen Pace, and returns its result. */
export async function playLocalGame(game: Game, options: PlayOptions): Promise<GameResult> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const tickMs = 1000 / game.setup.ruleset.tickRate;
  const start = now();
  for (;;) {
    const result = resultOf(game);
    if (result !== null) return result;
    const report = playTick(game);
    options.onTick?.(report, game);
    if (!options.unthrottled && resultOf(game) === null) {
      const wait = start + report.tick * tickMs - now();
      if (wait > 0) await sleep(wait);
    }
  }
}

/** Read through a call, since `playTick` sets it behind the type checker's back. */
function resultOf(game: Game): GameResult | null {
  return game.result;
}

/** Creates the Game, running every init phase. */
export function startGame(loaded: LoadedGame): Game {
  return createGame(loaded.setup);
}

export interface OutputFiles {
  readonly record: string;
  readonly replay: string;
  readonly programLogs: string;
}

/** The files `writeOutputs` writes into `dir`. */
export function outputFiles(dir: string): OutputFiles {
  return { record: join(dir, "game-record.json"), replay: join(dir, "replay.json"), programLogs: join(dir, "program-logs.json") };
}

/**
 * Writes the Game Record, the Replay and every Bot's Program log into `dir`,
 * creating it if needed. Locally you own every participant, so all Program
 * logs are written.
 */
export async function writeOutputs(game: Game, dir: string): Promise<OutputFiles> {
  const files = outputFiles(dir);
  await mkdir(dir, { recursive: true });
  // Compact: per-Tick arrays make indented output many times larger.
  const json = (v: unknown) => `${JSON.stringify(v)}\n`;
  await writeFile(files.record, json(gameRecord(game)));
  await writeFile(files.replay, json(replayOf(game)));
  await writeFile(files.programLogs, json(game.logs));
  return files;
}

/**
 * The tick cost check (ADR-0002; language-r1 sections 8.3 and 9): runs a
 * Program's init phase and then its `tick()` for a number of Ticks in a
 * sample world, and reports the operations each run used, the peak, and
 * persistent memory, so Players can see how close a Program comes to its
 * Operation Budget before entering it in a Game.
 *
 * The sample world is built here from the Ruleset alone, never from stored
 * data, so a check can reveal nothing about other Players: a fixed 60 x 40
 * Map with a Terrain Region and two Obstacles, the checked Bot, and one
 * sample Foe 20 m ahead of it, facing it. The Foe has the checked Bot's own
 * Build (so it is valid under any Ruleset) and a fixed Program that only
 * drives in a circle and never fires. The same Program, Build, Ticks and seed
 * always give the same report.
 *
 * The server's tick cost endpoints and the CLI's `positrontanks tick-cost` both run
 * this, so the two report the same numbers.
 */

import type { Build, MapFormat1, Ruleset } from "@positrontanks/ruleset-data";
import { createGame, playTick } from "./game.js";

/** Ticks run when a check names none: two simulated seconds in r1. */
export const TICK_COST_DEFAULT_TICKS = 20;
/** The most Ticks one check may run. */
export const TICK_COST_MAX_TICKS = 100;
/** The Game seed used when a check names none. */
export const TICK_COST_DEFAULT_SEED = 1;

/** The checked Bot's Bot Name in the sample world. */
export const SAMPLE_BOT_NAME = "you";
/** The sample Foe's Bot Name. */
export const SAMPLE_FOE_NAME = "sampleFoe";

/** The sample Foe's Program: circles slowly, never fires. */
export const SAMPLE_FOE_PROGRAM = `function tick() {
  throttle(0.5);
  turn(0.25);
}`;

export interface TickCostOptions {
  /** Ticks to run, 1 to TICK_COST_MAX_TICKS. */
  readonly ticks: number;
  /** The Game seed, an integer in [0, 2^32). */
  readonly seed: number;
}

/** Where and why a run stopped early. */
export interface RunStop {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** One run of the checked Program: its init phase, or one `tick()`. */
export interface CostedRun {
  readonly outcome: "completed" | "outOfBudget" | "error";
  readonly operations: number;
  /** Persistent state at the end of the run, in cells. */
  readonly memoryCells: number;
  readonly error: RunStop | null;
}

export interface TickCost {
  readonly rulesetVersion: string;
  /** The checked Bot's per-Tick Operation Budget, from its Processor. */
  readonly operationBudget: number;
  readonly seed: number;
  /** The Ticks asked for. */
  readonly ticks: number;
  readonly init: CostedRun & { readonly budget: number };
  /** One per Tick `tick()` ran, from Tick 1; fewer than `ticks` if the Program halted or the sample Game ended. */
  readonly runs: readonly (CostedRun & { readonly tick: number })[];
  /** The most operations one `tick()` used, and the first Tick it did; null if `tick()` never ran. */
  readonly peak: { readonly operations: number; readonly tick: number } | null;
  /** The largest persistent state over every run, and the cap. */
  readonly memory: { readonly peak: number; readonly cap: number };
  /** When and why the Program halted, or null. */
  readonly halt: { readonly tick: number; readonly reason: string } | null;
}

/** The sample Map, painted with the Ruleset's own Terrains. */
export function sampleMap(ruleset: Ruleset): MapFormat1 {
  const base = ruleset.terrains[0]?.name ?? "";
  const other = ruleset.terrains[1]?.name;
  const square = (x: number, y: number, half: number) => [
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x + half, y: y + half },
    { x: x - half, y: y + half },
  ];
  return {
    format: 1,
    width: 60,
    height: 40,
    baseTerrain: base,
    terrainRegions: other === undefined ? [] : [{ terrain: other, shape: "circle", x: 30, y: 20, radius: 4 }],
    obstacles: [
      { id: "pillar", destructible: false, shape: "circle", x: 30, y: 32, radius: 2 },
      { id: "crate", destructible: true, hitPoints: 150, shape: "polygon", points: square(30, 8, 2) },
    ],
    spawnZones: [
      { shape: "circle", x: 20, y: 20, radius: 3, heading: 90, capacity: 1 },
      { shape: "circle", x: 40, y: 20, radius: 3, heading: 270, capacity: 1 },
    ],
  };
}

const costed = (r: { outcome: CostedRun["outcome"]; operations: number; memoryCells: number; error: RunStop | null }): CostedRun => ({
  outcome: r.outcome,
  operations: r.operations,
  memoryCells: r.memoryCells,
  error: r.error === null ? null : { line: r.error.line, column: r.error.column, message: r.error.message },
});

/**
 * Checks the tick cost of a Program under an engine-r1 Ruleset. The Build
 * must have passed `validateBuild` and the Program `check` (as the server's
 * `checkDesign` and the CLI's `loadTickCostCheck` ensure).
 */
export function tickCostCheck(ruleset: Ruleset, build: Build, program: string, options: TickCostOptions): TickCost {
  const map = sampleMap(ruleset);
  const game = createGame({
    ruleset,
    map,
    seed: options.seed,
    timeLimitTicks: options.ticks,
    entries: [
      { player: "you", bots: [{ name: SAMPLE_BOT_NAME, build, program }] },
      { player: "sample", bots: [{ name: SAMPLE_FOE_NAME, build, program: SAMPLE_FOE_PROGRAM }] },
    ],
  });
  // The seed decides which side each Bot starts on; the two sides mirror each other.
  while (game.result === null) playTick(game);

  // Bot 1 is the checked Bot; only its runs are reported.
  const log = game.logs[0];
  const operationBudget = game.programs[0]?.bot.spec.operationBudget ?? 0;
  if (log === undefined) throw new Error("the sample Game has no checked Bot");
  let init: TickCost["init"] | undefined;
  const runs: (CostedRun & { tick: number })[] = [];
  let peak: TickCost["peak"] = null;
  let memoryPeak = 0;
  let halt: TickCost["halt"] = null;
  for (const { tick, result } of log.runs) {
    memoryPeak = Math.max(memoryPeak, result.memoryCells);
    if (result.halt !== null) halt = { tick, reason: result.halt };
    if (tick === 0) {
      init = { ...costed(result), budget: ruleset.limits.initBudgetMultiplier * operationBudget };
      continue;
    }
    runs.push({ tick, ...costed(result) });
    if (peak === null || result.operations > peak.operations) peak = { operations: result.operations, tick };
  }
  if (init === undefined) throw new Error("the checked Program's init phase did not run");
  return {
    rulesetVersion: ruleset.version,
    operationBudget,
    seed: options.seed,
    ticks: options.ticks,
    init,
    runs,
    peak,
    memory: { peak: memoryPeak, cap: ruleset.limits.memoryCells },
    halt,
  };
}

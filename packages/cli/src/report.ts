/**
 * What the CLI runner prints: the result and each Program's per-Tick budget
 * peaks (ADR-0002: per-Tick usage is reported in CLI output).
 */

import type { Game, GameResult } from "@aumohta/engine-r1";

/** How one Bot's Program used its Operation Budget and memory over the Game. */
export interface BudgetPeak {
  readonly bot: number;
  readonly name: string;
  readonly player: string;
  /** Operations per Tick. */
  readonly operationBudget: number;
  /** The init phase's operations and budget. */
  readonly init: { readonly operations: number; readonly budget: number };
  /** The most operations used in one Tick, and the first Tick it was used in; null if `tick()` never ran. */
  readonly peak: { readonly operations: number; readonly tick: number } | null;
  /** Ticks where `tick()` ran out of budget. */
  readonly outOfBudgetTicks: number;
  /** Ticks where `tick()` stopped at a runtime error. */
  readonly errorTicks: number;
  /** The largest persistent state, in cells, and the cap. */
  readonly memoryPeak: number;
  readonly memoryCells: number;
  /** When and why the Program halted, or null. */
  readonly halt: { readonly tick: number; readonly reason: string } | null;
}

export function budgetPeaks(game: Game): BudgetPeak[] {
  const { limits } = game.setup.ruleset;
  return game.logs.map((log, i) => {
    const operationBudget = game.programs[i]?.bot.spec.operationBudget ?? 0;
    let initOperations = 0;
    let peak: BudgetPeak["peak"] = null;
    let outOfBudgetTicks = 0;
    let errorTicks = 0;
    let memoryPeak = 0;
    let halt: BudgetPeak["halt"] = null;
    for (const { tick, result } of log.runs) {
      memoryPeak = Math.max(memoryPeak, result.memoryCells);
      if (result.halt !== null) halt = { tick, reason: result.halt };
      if (tick === 0) {
        initOperations = result.operations;
        continue;
      }
      if (peak === null || result.operations > peak.operations) peak = { operations: result.operations, tick };
      if (result.outcome === "outOfBudget") outOfBudgetTicks++;
      if (result.outcome === "error") errorTicks++;
    }
    return {
      bot: log.bot,
      name: log.name,
      player: log.player,
      operationBudget,
      init: { operations: initOperations, budget: limits.initBudgetMultiplier * operationBudget },
      peak,
      outOfBudgetTicks,
      errorTicks,
      memoryPeak,
      memoryCells: limits.memoryCells,
      halt,
    };
  });
}

const END_TEXT: Record<GameResult["end"], string> = {
  lastStanding: "last standing",
  noneStanding: "none standing",
  timeLimit: "time limit",
};

const DECIDED_TEXT: Record<NonNullable<GameResult["decidedBy"]>, string> = {
  survival: "by survival",
  foeDamage: "on Foe damage",
  hitPoints: "on remaining Hit Points",
};

/** Right-pads every column but the last to its widest cell. */
export function table(rows: readonly (readonly string[])[], indent = "  "): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => indent + row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd());
}

/** Formats a number for display, dropping float noise. */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export function formatResult(result: GameResult, tickRate: number): string[] {
  const when = `Tick ${String(result.tick)} (${num(result.tick / tickRate)} s)`;
  const headline =
    result.winner === null
      ? `Result: Draw (${END_TEXT[result.end]}) in ${when}`
      : `Result: ${result.winner} wins ${result.decidedBy === null ? "" : `${DECIDED_TEXT[result.decidedBy]} `}(${END_TEXT[result.end]}) in ${when}`;
  return [
    headline,
    ...table([
      ["Player", "Foe damage", "Hit Points", "Standing"],
      ...result.standings.map((s) => [s.player, num(s.foeDamage), num(s.hitPoints), s.remaining ? "yes" : "no"]),
    ]),
  ];
}

const pct = (part: number, whole: number) => (whole > 0 ? `${String(Math.round((part / whole) * 100))}%` : "-");

export function formatBudgetPeaks(peaks: readonly BudgetPeak[]): string[] {
  return [
    "Budget peaks (operations per Tick):",
    ...table([
      ["Bot", "Player", "Init", "Tick peak", "Out of budget", "Errors", "Memory peak", "Halted"],
      ...peaks.map((p) => [
        p.name,
        p.player,
        `${String(p.init.operations)}/${String(p.init.budget)} (${pct(p.init.operations, p.init.budget)})`,
        p.peak === null
          ? "-"
          : `${String(p.peak.operations)}/${String(p.operationBudget)} (${pct(p.peak.operations, p.operationBudget)}) at Tick ${String(p.peak.tick)}`,
        String(p.outOfBudgetTicks),
        String(p.errorTicks),
        `${String(p.memoryPeak)}/${String(p.memoryCells)} (${pct(p.memoryPeak, p.memoryCells)})`,
        p.halt === null ? "-" : `Tick ${String(p.halt.tick)}: ${p.halt.reason}`,
      ]),
    ]),
  ];
}

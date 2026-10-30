/**
 * The tick cost check offline (`positrontanks tick-cost`; ADR-0002): runs each Bot
 * of an Entry file in engine-r1's sample world with `tickCostCheck`, exactly
 * as the server's tick cost endpoints do, with no server or database.
 *
 * Each Bot's Build and Program are checked as the server checks a Bot Design
 * before a tick cost check: the Build against the Ruleset and its largest
 * Point Budget, and the Program with the language checker. Bot Names need not
 * be unique, and the Entry's total cost is not checked, since each Bot is
 * checked alone.
 */

import {
  deriveBotSpec,
  programSlots,
  tickCostCheck,
  TICK_COST_MAX_TICKS,
  type TickCost,
  type TickCostOptions,
} from "@positrontanks/engine-r1";
import { check, R1_LANGUAGE } from "@positrontanks/language";
import { validateBuild, type Build, type Ruleset } from "@positrontanks/ruleset-data";
import { isRulesetVersion, loadRuleset, RULESET_VERSIONS } from "@positrontanks/ruleset-data/rulesets";
import { InputError, readEntryFile } from "./entry-file.js";
import { table } from "./report.js";
import { SEED_LIMIT } from "./run.js";

export interface TickCostCheckOptions {
  readonly entryPath: string;
  /** The Ruleset version when the Entry file names none. */
  readonly defaultRuleset: string;
  readonly ticks: number;
  readonly seed: number;
}

/** An Entry file's Bots, checked and ready for the tick cost check. */
export interface LoadedTickCostCheck {
  readonly ruleset: Ruleset;
  readonly player: string;
  readonly bots: readonly { readonly name: string; readonly build: Build; readonly program: string }[];
  readonly options: TickCostOptions;
}

/** One Bot's report: the server endpoint's report, under the Bot's name. */
export interface BotTickCost {
  readonly name: string;
  readonly report: TickCost;
}

/** Reads and checks the Entry file and options. Throws InputError listing every problem found. */
export async function loadTickCostCheck(options: TickCostCheckOptions): Promise<LoadedTickCostCheck> {
  const { ticks, seed } = options;
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > TICK_COST_MAX_TICKS) {
    throw new InputError(`the Ticks must be a whole number from 1 to ${String(TICK_COST_MAX_TICKS)}, got ${String(ticks)}`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw new InputError(`the seed must be a whole number in [0, 2^32), got ${String(seed)}`);
  const file = await readEntryFile(options.entryPath);
  const version = file.ruleset ?? options.defaultRuleset;
  if (!isRulesetVersion(version)) throw new InputError(`unknown Ruleset "${version}"; this CLI supports ${RULESET_VERSIONS.join(", ")}`);
  const ruleset = loadRuleset(version);

  const errors: string[] = [];
  const bots: LoadedTickCostCheck["bots"][number][] = [];
  for (const bot of file.bots) {
    const where = `Bot "${bot.name}"`;
    const fail = (message: string) => errors.push(`${file.path}: ${where}: ${message}`);
    const validated = validateBuild(ruleset, bot.build);
    if (!validated.ok) {
      for (const e of validated.errors) fail(`${e.path} ${e.message}`);
      continue;
    }
    if (validated.cost > ruleset.pointBudget.max) {
      fail(`the Build costs ${String(validated.cost)} points, more than Ruleset ${ruleset.version}'s largest Point Budget of ${String(ruleset.pointBudget.max)}`);
    }
    const checked = check(bot.program, {
      language: R1_LANGUAGE,
      maxSourceBytes: ruleset.limits.maxSourceBytes,
      slots: programSlots(deriveBotSpec(ruleset, validated.build)),
    });
    if (!checked.ok) {
      for (const e of checked.errors) errors.push(`${bot.programSource}:${String(e.line)}:${String(e.column)}: ${where}: ${e.message}`);
    }
    bots.push({ name: bot.name, build: validated.build, program: bot.program });
  }
  if (errors.length > 0) throw new InputError(errors.join("\n"));
  return { ruleset, player: file.player, bots, options: { ticks, seed } };
}

/** Runs the tick cost check for every Bot, in Entry file order. */
export function runTickCostCheck(loaded: LoadedTickCostCheck): BotTickCost[] {
  return loaded.bots.map((bot) => ({ name: bot.name, report: tickCostCheck(loaded.ruleset, bot.build, bot.program, loaded.options) }));
}

const pct = (part: number, whole: number) => (whole > 0 ? `${String(Math.round((part / whole) * 100))}%` : "-");

/** A table of each Bot's init, peak, memory and halt, then each Bot's operations per Tick. */
export function formatTickCosts(costs: readonly BotTickCost[]): string[] {
  const count = (r: TickCost, outcome: string) => String(r.runs.filter((run) => run.outcome === outcome).length);
  return [
    "Tick cost (operations per Tick):",
    ...table([
      ["Bot", "Init", "Tick peak", "Out of budget", "Errors", "Memory peak", "Halted"],
      ...costs.map(({ name, report: r }) => [
        name,
        `${String(r.init.operations)}/${String(r.init.budget)} (${pct(r.init.operations, r.init.budget)})`,
        r.peak === null
          ? "-"
          : `${String(r.peak.operations)}/${String(r.operationBudget)} (${pct(r.peak.operations, r.operationBudget)}) at Tick ${String(r.peak.tick)}`,
        count(r, "outOfBudget"),
        count(r, "error"),
        `${String(r.memory.peak)}/${String(r.memory.cap)} (${pct(r.memory.peak, r.memory.cap)})`,
        r.halt === null ? "-" : `Tick ${String(r.halt.tick)}: ${r.halt.reason}`,
      ]),
    ]),
    "",
    "Operations by Tick, from Tick 1:",
    ...table(costs.map(({ name, report: r }) => [name, r.runs.length === 0 ? "-" : r.runs.map((run) => String(run.operations)).join(" ")])),
  ];
}

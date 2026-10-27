import { checkMapTerrains, validateBuild, validateMap, type Build } from "@aumohta/ruleset-data";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { sampleMap, tickCostCheck } from "./tick-cost.js";

const r1 = loadRuleset("r1");

const noArmor = { front: null, left: null, right: null, rear: null };

/** Scout + pellet gun + radar + wheels; the minimal Processor's 1,000 operations per Tick. */
function build(): Build {
  const result = validateBuild(r1, { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor });
  if (!result.ok) throw new Error("the test Build is invalid");
  return result.build;
}

/** 6 operations every Tick: each built-in call costs 2, plus 1 for its literal argument. */
const STEADY = "function tick() { throttle(1); turn(0.5); }";

describe("the sample world", () => {
  it("is a valid Map painted with the Ruleset's own Terrains", () => {
    const result = validateMap(sampleMap(r1));
    expect(result.ok).toBe(true);
    expect(checkMapTerrains(sampleMap(r1), new Set(r1.terrains.map((t) => t.name)))).toEqual([]);
  });
});

describe("tickCostCheck", () => {
  it("reports the operations of every Tick, the peak and memory", () => {
    const report = tickCostCheck(r1, build(), STEADY, { ticks: 4, seed: 1 });
    expect(report).toMatchObject({
      rulesetVersion: "r1",
      operationBudget: 1000,
      seed: 1,
      ticks: 4,
      init: { outcome: "completed", operations: 0, budget: 50_000, error: null },
      peak: { operations: 6, tick: 1 },
      memory: { peak: 0, cap: 10_000 },
      halt: null,
    });
    expect(report.runs.map((r) => [r.tick, r.operations])).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
    ]);
  });

  it("reports a Program that halts in its init phase, with no Ticks", () => {
    const report = tickCostCheck(r1, build(), "function init() { while (true) {} }\nfunction tick() {}", { ticks: 5, seed: 1 });
    expect(report.init.outcome).toBe("outOfBudget");
    expect(report.halt?.tick).toBe(0);
    expect(report.runs).toEqual([]);
    expect(report.peak).toBeNull();
  });

  it("is deterministic for the same Program, Build, Ticks and seed", () => {
    const program = "let r = 0; function tick() { if (random() < 0.5) { r = r + 1; } }";
    expect(tickCostCheck(r1, build(), program, { ticks: 10, seed: 7 })).toEqual(tickCostCheck(r1, build(), program, { ticks: 10, seed: 7 }));
  });
});

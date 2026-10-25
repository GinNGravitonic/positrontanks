/**
 * The Ruleset versions this server hosts (spec section 5).
 *
 * Each hosted version pairs its Ruleset data with what the server needs to
 * check Programs written for it: the language definition, and how to find a
 * Build's weapon and rangefinder Slots, which comes from that version's
 * frozen engine so save-time checks agree exactly with what the engine runs,
 * and that engine itself, which the Game runner plays the version's Games on.
 *
 * Adding a Ruleset version means shipping its data in ruleset-data and adding
 * an entry to `hostVersion` below wired to its engine.
 */

import { deriveBotSpec, programSlots } from "@aumohta/engine-r1";
import { R1_LANGUAGE, type LanguageDefinition, type ProgramSlots } from "@aumohta/language";
import type { Build, Ruleset } from "@aumohta/ruleset-data";
import { r1Engine, type GameEngine } from "../games/engine.js";
import { loadRuleset, RULESET_VERSIONS, type RulesetVersion } from "@aumohta/ruleset-data/rulesets";
import { checkTickCostR1, type TickCost, type TickCostOptions } from "../garage/tick-cost.js";

export interface HostedRuleset {
  readonly ruleset: Ruleset;
  readonly language: LanguageDefinition;
  /** The Slot ids a Program may name in `fire`, `fireAbs` and `rangefind`, for a Build validated under `ruleset`. */
  programSlots(build: Build): ProgramSlots;
  /** Runs a checked Program in that version's sample world and reports its operation cost (garage/tick-cost.ts). */
  checkTickCost(build: Build, program: string, options: TickCostOptions): TickCost;
  /** Plays Games under `ruleset`. */
  readonly engine: GameEngine;
}

export class RulesetCatalog {
  readonly #byVersion: ReadonlyMap<string, HostedRuleset>;

  constructor(hosted: readonly HostedRuleset[]) {
    const byVersion = new Map<string, HostedRuleset>();
    for (const h of hosted) {
      if (byVersion.has(h.ruleset.version)) throw new Error(`Ruleset ${h.ruleset.version} is hosted twice`);
      byVersion.set(h.ruleset.version, h);
    }
    this.#byVersion = byVersion;
  }

  /** The hosted version, if any. */
  get(version: string): HostedRuleset | undefined {
    return this.#byVersion.get(version);
  }

  /** Every hosted version, oldest first. */
  versions(): string[] {
    return [...this.#byVersion.keys()];
  }
}

/** A Ruleset run by engine-r1 with the r1 language: r1 itself, or a test variant of it. */
export function engineR1Ruleset(ruleset: Ruleset): HostedRuleset {
  return {
    ruleset,
    language: R1_LANGUAGE,
    programSlots: (build) => programSlots(deriveBotSpec(ruleset, build)),
    checkTickCost: (build, program, options) => checkTickCostR1(ruleset, build, program, options),
    engine: r1Engine(ruleset),
  };
}

/** How to host each shipped version; a version shipped without an entry here fails to compile. */
const hostVersion: Readonly<Record<RulesetVersion, (ruleset: Ruleset) => HostedRuleset>> = {
  r1: engineR1Ruleset,
};

/** The catalog of every Ruleset version ruleset-data ships. */
export function defaultRulesetCatalog(): RulesetCatalog {
  return new RulesetCatalog(RULESET_VERSIONS.map((version) => hostVersion[version](loadRuleset(version))));
}

/**
 * The Ruleset versions this server hosts (spec section 5).
 *
 * Each hosted version pairs its Ruleset data with what the server needs to
 * check Programs written for it: the language definition, and how to find a
 * Build's weapon and rangefinder Slots, which comes from that version's
 * frozen engine so save-time checks agree exactly with what the engine runs,
 * and that engine itself, which the Game runner plays the version's Games on.
 * It also carries the version's prose documents, which the server publishes.
 *
 * Adding a Ruleset version means shipping its data in ruleset-data and adding
 * an entry to `hostVersion` below wired to its engine.
 */

import { deriveBotSpec, programSlots, tickCostCheck, type TickCost, type TickCostOptions } from "@aumohta/engine-r1";
import { R1_LANGUAGE, type LanguageDefinition, type ProgramSlots } from "@aumohta/language";
import type { Build, Ruleset } from "@aumohta/ruleset-data";
import { r1Engine, type GameEngine } from "../games/engine.js";
import {
  loadRuleset,
  loadRulesetDocs,
  RULESET_VERSIONS,
  type RulesetDocs,
  type RulesetVersion,
} from "@aumohta/ruleset-data/rulesets";

export interface HostedRuleset {
  readonly ruleset: Ruleset;
  readonly language: LanguageDefinition;
  /** The prose documents (Markdown) explaining the version: simulation rules, language spec and Parts Catalog. */
  readonly docs: RulesetDocs;
  /** The Slot ids a Program may name in `fire`, `fireAbs` and `rangefind`, for a Build validated under `ruleset`. */
  programSlots(build: Build): ProgramSlots;
  /** Runs a checked Program in that version's sample world and reports its operation cost (the engine's tick cost check). */
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

/**
 * A Ruleset run by engine-r1 with the r1 language: r1 itself, or a test
 * variant of it, which publishes r1's prose documents unless given its own.
 */
export function engineR1Ruleset(ruleset: Ruleset, docs: RulesetDocs = loadRulesetDocs("r1")): HostedRuleset {
  return {
    ruleset,
    language: R1_LANGUAGE,
    docs,
    programSlots: (build) => programSlots(deriveBotSpec(ruleset, build)),
    checkTickCost: (build, program, options) => tickCostCheck(ruleset, build, program, options),
    engine: r1Engine(ruleset),
  };
}

/** How to host each shipped version; a version shipped without an entry here fails to compile. */
const hostVersion: Readonly<Record<RulesetVersion, (ruleset: Ruleset) => HostedRuleset>> = {
  r1: (ruleset) => engineR1Ruleset(ruleset, loadRulesetDocs("r1")),
};

/** The catalog of every Ruleset version ruleset-data ships. */
export function defaultRulesetCatalog(): RulesetCatalog {
  return new RulesetCatalog(RULESET_VERSIONS.map((version) => hostVersion[version](loadRuleset(version))));
}

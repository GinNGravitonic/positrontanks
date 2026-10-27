/**
 * Loading the Ruleset data files that ship with this package (Node only).
 *
 * Each released Ruleset lives at `rulesets/<version>.json` in the package
 * and is also reachable as the JSON subpath `@aumohta/ruleset-data/rulesets/<version>.json`.
 * This module, imported as `@aumohta/ruleset-data/rulesets`, finds and
 * validates them so consumers (engine tests, golden Games, the CLI, the
 * server) need not know the package layout. It is kept out of the main entry
 * point so that entry stays free of `node:fs`.
 *
 * Each released Ruleset also ships its prose documents, which the server
 * publishes per version, at `spec/<version>/<doc>-<version>.md` for each of
 * RULESET_DOCS. These files are the single source of those documents. Links
 * between them use the URLs the server serves them at
 * (`/rulesets/<version>/docs/<doc>`); they never link to other repo files.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRuleset, type Ruleset } from "./ruleset.js";

/** The Ruleset versions this package ships, oldest first. */
export const RULESET_VERSIONS = ["r1"] as const;
export type RulesetVersion = (typeof RULESET_VERSIONS)[number];

export function isRulesetVersion(v: string): v is RulesetVersion {
  return RULESET_VERSIONS.some((known) => known === v);
}

/** The absolute file path of a shipped Ruleset's JSON. */
export function rulesetPath(version: RulesetVersion): string {
  // Resolves the same from src/ (tests) and dist/ (built), both one level below the package root.
  return fileURLToPath(new URL(`../rulesets/${version}.json`, import.meta.url));
}

/** The JSON text of a shipped Ruleset, unvalidated, as stored. */
export function readRulesetJson(version: RulesetVersion): string {
  return readFileSync(rulesetPath(version), "utf8");
}

/** Reads and validates a shipped Ruleset; throws if it is invalid, which a test guards against. */
export function loadRuleset(version: RulesetVersion): Ruleset {
  const result = parseRuleset(readRulesetJson(version));
  if (!result.ok) {
    const details = result.errors.map((e) => `${e.path} ${e.message}`).join("; ");
    throw new Error(`Ruleset ${version} is invalid: ${details}`);
  }
  return result.ruleset;
}

/** The prose documents each shipped Ruleset version publishes: its simulation rules, language spec and Parts Catalog. */
export const RULESET_DOCS = ["engine", "language", "catalog"] as const;
export type RulesetDoc = (typeof RULESET_DOCS)[number];

/** A Ruleset version's prose documents, as Markdown text. */
export type RulesetDocs = Readonly<Record<RulesetDoc, string>>;

export function isRulesetDoc(d: string): d is RulesetDoc {
  return RULESET_DOCS.some((known) => known === d);
}

/** The absolute file path of one of a shipped Ruleset's prose documents. */
export function rulesetDocPath(version: RulesetVersion, doc: RulesetDoc): string {
  return fileURLToPath(new URL(`../spec/${version}/${doc}-${version}.md`, import.meta.url));
}

/** Reads a shipped Ruleset's prose documents (Markdown). */
export function loadRulesetDocs(version: RulesetVersion): RulesetDocs {
  const read = (doc: RulesetDoc): string => readFileSync(rulesetDocPath(version, doc), "utf8");
  return { engine: read("engine"), language: read("language"), catalog: read("catalog") };
}

/**
 * Save-time validation of a Bot Design Revision (spec section 3,
 * language-r1 section 10.1), also used to re-validate a design copied to
 * another Ruleset.
 *
 * A Revision is valid when its Build passes the Ruleset's Build validation,
 * costs no more than the Ruleset's largest Point Budget (otherwise no Game
 * could ever accept it), and its Program passes the language checker. The
 * checker is given the Build's weapon and rangefinder Slots so literal Slot
 * ids in `fire`, `fireAbs` and `rangefind` are checked too. Every problem is
 * reported at once.
 */

import { check } from "@positrontanks/language";
import { validateBuild, type Build } from "@positrontanks/ruleset-data";
import type { ErrorDetail } from "../http/errors.js";
import type { HostedRuleset } from "../rulesets/catalog.js";

export type DesignCheck =
  | { readonly ok: true; readonly build: Build; readonly program: string; readonly cost: number }
  | {
      readonly ok: false;
      /** The Build's cost, when the Build itself is valid. */
      readonly cost: number | null;
      readonly problems: readonly ErrorDetail[];
    };

/** Validates a Build and Program (as parsed from a request) under a hosted Ruleset. */
export function checkDesign(hosted: HostedRuleset, build: unknown, program: unknown): DesignCheck {
  const { ruleset } = hosted;
  const problems: ErrorDetail[] = [];

  let valid: { build: Build; cost: number } | undefined;
  if (build === undefined) {
    problems.push({ path: "build", message: "is required" });
  } else {
    const result = validateBuild(ruleset, build);
    if (result.ok) {
      valid = { build: result.build, cost: result.cost };
      if (result.cost > ruleset.pointBudget.max) {
        problems.push({
          path: "build",
          message:
            `costs ${String(result.cost)} points, more than Ruleset ${ruleset.version}'s ` +
            `largest Point Budget of ${String(ruleset.pointBudget.max)}`,
        });
      }
    } else {
      problems.push(...result.errors);
    }
  }

  if (program === undefined) {
    problems.push({ path: "program", message: "is required" });
  } else if (typeof program !== "string") {
    problems.push({ path: "program", message: "must be a string" });
  } else {
    const checked = check(program, {
      language: hosted.language,
      maxSourceBytes: ruleset.limits.maxSourceBytes,
      ...(valid === undefined ? {} : { slots: hosted.programSlots(valid.build) }),
    });
    if (!checked.ok) {
      for (const e of checked.errors) problems.push({ path: "program", line: e.line, column: e.column, message: e.message });
    }
  }

  if (problems.length > 0 || valid === undefined || typeof program !== "string") {
    return { ok: false, cost: valid?.cost ?? null, problems };
  }
  return { ok: true, build: valid.build, program, cost: valid.cost };
}

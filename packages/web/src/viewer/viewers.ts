/**
 * The engine viewer registry (frontend spec section 3): the viewer for each
 * Ruleset version, by the engine that plays it. Every Ruleset the server
 * hosts must have one (viewers.test.ts); a Ruleset no longer hosted may lose
 * its viewer, and its Finished Games then say so instead of showing a Replay.
 */

import { r1Viewer } from "./r1.js";
import type { EngineViewer } from "./scene.js";

const VIEWERS: Readonly<Record<string, EngineViewer>> = {
  r1: r1Viewer,
};

/** The viewer for Games of Ruleset `version`, if the client has one. */
export function viewerFor(version: string): EngineViewer | undefined {
  return Object.hasOwn(VIEWERS, version) ? VIEWERS[version] : undefined;
}

/** The Ruleset versions among `versions` that have no viewer. */
export function missingViewers(versions: readonly string[]): string[] {
  return versions.filter((version) => viewerFor(version) === undefined);
}

/** What a Finished Game of a Ruleset without a viewer shows instead of its Replay. */
export function unsupportedText(version: string): string {
  return `Ruleset ${version} is no longer supported.`;
}

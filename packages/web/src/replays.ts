/**
 * What the viewer loads for a Finished Game (frontend spec sections 3 and
 * 6): its Replay, read by the viewer for its Ruleset, and that Ruleset's
 * Parts Catalog, which the Bots are drawn from. A Ruleset with no viewer is
 * not loaded at all.
 */

import type { ApiClient, Schema } from "./api/client.js";
import type { Catalog } from "./draw/bot.js";
import type { Game } from "./games.js";
import type { ViewerReplay } from "./viewer/scene.js";
import { viewerFor } from "./viewer/viewers.js";

export type PartsCatalog = Schema<"PartsCatalog">;

export function getReplay(api: ApiClient, gameId: string): Promise<Schema<"GameReplay">> {
  return api.request<Schema<"GameReplay">>("GET", `/games/${encodeURIComponent(gameId)}/replay`);
}

export function getPartsCatalog(api: ApiClient, version: string): Promise<PartsCatalog> {
  return api.request<PartsCatalog>("GET", `/rulesets/${encodeURIComponent(version)}/parts`);
}

export type LoadedReplay =
  | { readonly kind: "unsupported"; readonly version: string }
  | { readonly kind: "replay"; readonly replay: ViewerReplay; readonly catalog: Catalog };

/** A Finished Game's Replay and Parts Catalog, or that its Ruleset has no viewer. */
export async function loadReplay(api: ApiClient, game: Pick<Game, "id" | "rulesetVersion">): Promise<LoadedReplay> {
  const viewer = viewerFor(game.rulesetVersion);
  if (viewer === undefined) return { kind: "unsupported", version: game.rulesetVersion };
  const [{ replay }, catalog] = await Promise.all([getReplay(api, game.id), getPartsCatalog(api, game.rulesetVersion)]);
  // The API's Chassis and Component schemas describe the Ruleset's own types.
  return { kind: "replay", replay: viewer.load(replay), catalog: catalog as unknown as Catalog };
}

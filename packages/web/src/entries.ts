/**
 * Entering a Game, for the Enter Game screen (frontend spec section 5): the
 * Player's Bot Designs for the Game's Ruleset, the Bots picked from them as
 * typed, their running total, and submitting the Entry.
 */

import type { ApiClient, Schema } from "./api/client.js";
import type { FormProblems, Game } from "./games.js";

export type BotDesignSummary = Schema<"BotDesignSummary">;
export type NewGameEntry = Schema<"NewGameEntry">;
export type SubmittedGameEntry = Schema<"SubmittedGameEntry">;

/** The longest Bot Name the API takes. */
export const BOT_NAME_MAX_LENGTH = 32;

/** The Player's unarchived Bot Designs authored for `rulesetVersion`, most recently changed first. */
export async function designsForRuleset(api: ApiClient, rulesetVersion: string): Promise<readonly BotDesignSummary[]> {
  const list = await api.request<Schema<"BotDesignList">>("GET", "/bot-designs", { query: { rulesetVersion, limit: 200 } });
  return list.botDesigns;
}

/** Submits an Entry (`POST /games/{id}/entries`); the Game comes back Running if the Entry filled it. */
export function submitEntry(api: ApiClient, gameId: string, entry: NewGameEntry): Promise<SubmittedGameEntry> {
  return api.request<SubmittedGameEntry>("POST", `/games/${encodeURIComponent(gameId)}/entries`, { body: entry });
}

/** One Bot of the Entry being made, as typed: `key` tells rows apart while they are added and removed. */
export interface EntryBotFields {
  readonly key: number;
  readonly designId: string;
  readonly name: string;
}

/** The Entry's problems: `bots` for the Entry as a whole, `bots[i].name` and `bots[i].designId` for its Bots. */
export type EntryProblems = FormProblems<string>;

export const botField = (index: number, field: "name" | "designId") => `bots[${String(index)}].${field}`;

/** Bot Names compare ignoring case, as the API compares them. */
const nameKey = (name: string) => name.trim().toLowerCase();

/** Bot Names already taken in the Game by other Players' Entries. */
export function takenBotNames(game: Game): readonly string[] {
  return game.entries.flatMap((entry) => entry.bots.map((bot) => bot.name));
}

/**
 * A name for a new Bot of `design`: the design's name, or with ` 2`, ` 3`
 * and so on after it, so that it clashes with none of `taken`.
 */
export function newBotName(design: Pick<BotDesignSummary, "name">, taken: readonly string[]): string {
  const keys = new Set(taken.map(nameKey));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${String(n)}`;
    const name = `${design.name.slice(0, BOT_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!keys.has(nameKey(name))) return name;
  }
}

/** The Entry's cost so far: each Bot's design at its latest Revision; a design no longer listed costs nothing. */
export function entryTotal(bots: readonly EntryBotFields[], designs: readonly BotDesignSummary[]): number {
  return bots.reduce((total, bot) => total + (designs.find((d) => d.id === bot.designId)?.latestRevision.cost ?? 0), 0);
}

/**
 * The Entry to submit, each Bot at its design's latest Revision as listed,
 * or the problems that stop it being sent: no Bots, or a Bot Name that is
 * empty or used twice. The Point Budget and everything else is for the
 * server to judge.
 */
export function entryFromFields(
  bots: readonly EntryBotFields[],
  designs: readonly BotDesignSummary[],
): { readonly entry: NewGameEntry } | { readonly problems: EntryProblems } {
  if (bots.length === 0) return { problems: { fields: { bots: "Add at least one Bot." } } };
  const problems: Record<string, string> = {};
  const seen = new Set<string>();
  bots.forEach((bot, i) => {
    const key = nameKey(bot.name);
    if (key === "") problems[botField(i, "name")] = "Give this Bot a name.";
    else if (seen.has(key)) problems[botField(i, "name")] = "Is already used in this Entry.";
    seen.add(key);
  });
  if (Object.keys(problems).length > 0) return { problems: { fields: problems } };
  return {
    entry: {
      bots: bots.map((bot) => {
        const revision = designs.find((d) => d.id === bot.designId)?.latestRevision.number;
        return { designId: bot.designId, name: bot.name.trim(), ...(revision === undefined ? {} : { revision }) };
      }),
    },
  };
}

/** The fields the API's problems may name for an Entry of `count` Bots, and the paths shown under another field. */
export function entryProblemFields(count: number): { readonly fields: readonly string[]; readonly aliases: Readonly<Record<string, string>> } {
  const indexes = Array.from({ length: count }, (_, i) => i);
  return {
    fields: ["bots", ...indexes.flatMap((i) => [botField(i, "name"), botField(i, "designId")])],
    aliases: Object.fromEntries(indexes.map((i) => [`bots[${String(i)}].revision`, botField(i, "designId")])),
  };
}

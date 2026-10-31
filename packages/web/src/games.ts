/**
 * Games for the Games screen and the Game page (frontend spec section 5):
 * the API calls, the filters as they appear in a route's query, and the
 * words the screens show for a Game's state, outcome and failures.
 */

import { ApiError, type ApiClient, type Schema } from "./api/client.js";

export type Game = Schema<"Game">;
export type GameSummary = Schema<"GameSummary">;
export type GameList = Schema<"GameList">;
export type GameState = Game["state"];

export const GAME_STATES: readonly GameState[] = ["open", "running", "finished", "cancelled"];

/** Games asked for per page. */
export const GAMES_PAGE_LIMIT = 25;

/** The browse filters (`GET /games`); every one optional. */
export interface BrowseFilters {
  readonly rulesetVersion?: string;
  readonly mapId?: string;
  readonly playerCount?: number;
  readonly minPointBudget?: number;
  readonly maxPointBudget?: number;
}

/** Route query parameter for each browse filter. */
const FILTER_PARAMS = {
  rulesetVersion: "ruleset",
  mapId: "map",
  playerCount: "players",
  minPointBudget: "minBudget",
  maxPointBudget: "maxBudget",
} as const satisfies Record<keyof BrowseFilters, string>;

const NUMBER_FILTERS = new Set<keyof BrowseFilters>(["playerCount", "minPointBudget", "maxPointBudget"]);

/** The browse filters in a route's query; values that are empty or not whole numbers where numbers are due are left out. */
export function filtersFromSearch(search: URLSearchParams): BrowseFilters {
  const filters: Record<string, string | number> = {};
  for (const [key, param] of Object.entries(FILTER_PARAMS) as [keyof BrowseFilters, string][]) {
    const value = search.get(param)?.trim() ?? "";
    if (value === "") continue;
    if (!NUMBER_FILTERS.has(key)) filters[key] = value;
    else if (/^\d+$/.test(value)) filters[key] = Number(value);
  }
  return filters;
}

/** The query for `filters`, as `filtersFromSearch` reads it. */
export function searchFromFilters(filters: BrowseFilters): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, param] of Object.entries(FILTER_PARAMS) as [keyof BrowseFilters, string][]) {
    const value = filters[key];
    if (value !== undefined && value !== "") search.set(param, String(value));
  }
  return search;
}

/** The My Games state filter in a route's query (`state=open,running`); every state when none is given. */
export function statesFromSearch(search: URLSearchParams): readonly GameState[] {
  const named = (search.get("state") ?? "").split(",");
  return GAME_STATES.filter((state) => named.includes(state));
}

/** One page of Open Games (`GET /games`), newest first. */
export function browseGames(api: ApiClient, filters: BrowseFilters, cursor?: string): Promise<GameList> {
  return api.request<GameList>("GET", "/games", { query: { ...filters, limit: GAMES_PAGE_LIMIT, cursor } });
}

/** One page of the Games the Player initiated or entered (`GET /players/me/games`), newest first; every state when `states` is empty. */
export function myGames(api: ApiClient, states: readonly GameState[], cursor?: string): Promise<GameList> {
  const state = states.length === 0 ? undefined : states.join(",");
  return api.request<GameList>("GET", "/players/me/games", { query: { state, limit: GAMES_PAGE_LIMIT, cursor } });
}

const gamePath = (id: string) => `/games/${encodeURIComponent(id)}`;

export function getGame(api: ApiClient, id: string): Promise<Game> {
  return api.request<Game>("GET", gamePath(id));
}

/** Cancels an Open Game the Player initiated; returns it Cancelled. */
export function cancelGame(api: ApiClient, id: string): Promise<Game> {
  return api.request<Game>("POST", `${gamePath(id)}/cancel`);
}

export async function withdrawEntry(api: ApiClient, gameId: string, entryId: string): Promise<void> {
  await api.request("DELETE", `${gamePath(gameId)}/entries/${encodeURIComponent(entryId)}`);
}

/** What the Player may do on an Open Game's page. */
export interface GameActions {
  /** May enter: has no Entry yet. */
  readonly enter: boolean;
  /** The Player's own Entry, which they may withdraw. */
  readonly withdrawEntryId?: string;
  /** May cancel: is its Initiator. */
  readonly cancel: boolean;
}

export function gameActions(game: Game, playerId: string): GameActions {
  if (game.state !== "open") return { enter: false, cancel: false };
  const own = game.entries.find((entry) => entry.player.id === playerId);
  return {
    enter: own === undefined && game.entryCount < game.playerCount,
    ...(own === undefined ? {} : { withdrawEntryId: own.id }),
    cancel: game.initiator.id === playerId,
  };
}

/** A failed action, in words: the server's message and each problem it lists. */
export function problemText(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  return [error.message, ...error.details.map((detail) => `${detail.path === "" ? "" : `${detail.path} `}${detail.message}.`)].join(" ");
}

export const STATE_TEXT: Record<GameState, string> = { open: "Open", running: "Running", finished: "Finished", cancelled: "Cancelled" };
export const PACE_TEXT: Record<Game["pace"], string> = { realtime: "real time", unthrottled: "unthrottled" };

const END_TEXT: Record<NonNullable<Game["result"]>["end"], string> = {
  last_standing: "last standing",
  none_standing: "none standing",
  time_limit: "time limit",
};
const DECIDED_TEXT: Record<NonNullable<NonNullable<Game["result"]>["decidedBy"]>, string> = {
  survival: "by survival",
  foe_damage: "on damage dealt to Foes",
  hit_points: "on remaining Hit Points",
};

/** A Finished Game's result: `ada wins by survival (last standing, Tick 812)` or `Draw (time limit, Tick 1200)`. */
export function resultText(result: NonNullable<Game["result"]>): string {
  const how = `${END_TEXT[result.end]}, Tick ${String(result.tick)}`;
  if (result.winner === null) return `Draw (${how})`;
  const decided = result.decidedBy === null ? "" : `${DECIDED_TEXT[result.decidedBy]} `;
  return `${result.winner.username} wins ${decided}(${how})`;
}

/** Why a Cancelled Game was cancelled. */
export function cancelReasonText(game: Pick<Game, "cancelReason" | "initiator">): string {
  switch (game.cancelReason) {
    case "initiator":
      return `Cancelled by its Initiator, ${game.initiator.username}.`;
    case "fill_timeout":
      return "Cancelled because it was not full by its fill deadline.";
    case "server_error":
      return "Cancelled unplayed: the server could not play it.";
    case null:
      return "Cancelled.";
  }
}

export const localTime = (iso: string): string => new Date(iso).toLocaleString();

/** Where a Game stands, in a few words, for a list. */
export function outcomeText(game: GameSummary): string {
  switch (game.state) {
    case "open":
      return `${String(game.entryCount)} of ${String(game.playerCount)} Entries, fills by ${localTime(game.fillDeadline)}`;
    case "running":
      return game.startedAt === null ? "Running" : `Running since ${localTime(game.startedAt)}`;
    case "finished":
      return game.result === null ? "Finished" : resultText(game.result);
    case "cancelled":
      return cancelReasonText(game);
  }
}

export type NewGame = Schema<"NewGame">;
export type RulesetSummary = Schema<"RulesetSummary">;
export type MapSummary = Schema<"MapSummary">;

/** Creates an Open Game with no Entries (`POST /games`). */
export function createGame(api: ApiClient, game: NewGame): Promise<Game> {
  return api.request<Game>("POST", "/games", { body: game });
}

/** The Create Game form's fields, as typed; each is named as in `NewGame`, so the API's problems name them too. */
export interface NewGameFields {
  readonly rulesetVersion: string;
  readonly mapId: string;
  readonly playerCount: string;
  readonly pointBudget: string;
  readonly timeLimitSeconds: string;
  readonly pace: NewGame["pace"];
  readonly fillTimeoutSeconds: string;
}

export type NewGameField = keyof NewGameFields;

/** Problems with a form: by the field they belong to, and any others for above the form. */
export interface FormProblems<Field extends string> {
  readonly form?: string;
  readonly fields: Partial<Record<Field, string>>;
}

/** The defaults `positrontanks games create` uses, and so the form starts from. */
export const NEW_GAME_DEFAULTS = { playerCount: 2, timeLimitSeconds: 120, pace: "realtime", fillTimeoutSeconds: 3600 } as const;

/** Maps a Ruleset can play on: those whose latest Revision is in a Map Format it supports. */
export function playableMaps(maps: readonly MapSummary[], ruleset: RulesetSummary | undefined): readonly MapSummary[] {
  return ruleset === undefined ? [] : maps.filter((map) => ruleset.mapFormats.includes(map.latestRevision.format));
}

/**
 * The form's starting values: the newest Ruleset with its largest Point
 * Budget, its first playable Map, and the CLI's defaults for the rest.
 */
export function newGameFields(rulesets: readonly RulesetSummary[], maps: readonly MapSummary[]): NewGameFields {
  const ruleset = rulesets.at(-1);
  return {
    rulesetVersion: ruleset?.version ?? "",
    mapId: playableMaps(maps, ruleset)[0]?.id ?? "",
    playerCount: String(NEW_GAME_DEFAULTS.playerCount),
    pointBudget: ruleset === undefined ? "" : String(ruleset.pointBudget.max),
    timeLimitSeconds: String(NEW_GAME_DEFAULTS.timeLimitSeconds),
    pace: NEW_GAME_DEFAULTS.pace,
    fillTimeoutSeconds: String(NEW_GAME_DEFAULTS.fillTimeoutSeconds),
  };
}

const NUMBER_FIELDS = ["playerCount", "pointBudget", "timeLimitSeconds", "fillTimeoutSeconds"] as const;

/**
 * The Game to create from the form, or the problems that stop it being sent:
 * a missing Ruleset or Map, or a number that is not whole. Everything else
 * is for the server to judge.
 */
export function newGameFromFields(fields: NewGameFields): { readonly game: NewGame } | { readonly problems: FormProblems<NewGameField> } {
  const problems: Partial<Record<NewGameField, string>> = {};
  if (fields.rulesetVersion === "") problems.rulesetVersion = "Choose a Ruleset.";
  if (fields.mapId === "") problems.mapId = "Choose a Map.";
  const numbers: Partial<Record<(typeof NUMBER_FIELDS)[number], number>> = {};
  for (const name of NUMBER_FIELDS) {
    const value = fields[name].trim();
    if (/^\d+$/.test(value)) numbers[name] = Number(value);
    else problems[name] = "Must be a whole number.";
  }
  const { playerCount, pointBudget, timeLimitSeconds, fillTimeoutSeconds } = numbers;
  if (playerCount === undefined || pointBudget === undefined || timeLimitSeconds === undefined || fillTimeoutSeconds === undefined || Object.keys(problems).length > 0) {
    return { problems: { fields: problems } };
  }
  return {
    game: { rulesetVersion: fields.rulesetVersion, mapId: fields.mapId, playerCount, pointBudget, timeLimitSeconds, pace: fields.pace, fillTimeoutSeconds },
  };
}

/**
 * A failed submission's problems: each detail the API gives against one of
 * `fields` is shown by that field (`aliases` names fields shown under another,
 * such as `mapRevision` under the Map), and anything else above the form.
 */
export function formProblems<Field extends string>(
  error: unknown,
  fields: readonly Field[],
  aliases: Readonly<Record<string, Field>> = {},
): FormProblems<Field> {
  if (!(error instanceof ApiError)) return { form: problemText(error), fields: {} };
  const byField: Partial<Record<Field, string>> = {};
  const other: string[] = [];
  for (const detail of error.details) {
    const field = aliases[detail.path] ?? fields.find((f) => f === detail.path);
    const sentence = `${capitalize(detail.message)}.`;
    if (field === undefined) other.push(`${detail.path === "" ? "" : `${detail.path} `}${detail.message}.`);
    else byField[field] = byField[field] === undefined ? sentence : `${byField[field]} ${sentence}`;
  }
  if (error.details.length > 0 && other.length === 0) return { fields: byField };
  return { form: [error.message, ...other].join(" "), fields: byField };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

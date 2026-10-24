/**
 * Games and Entries (spec sections 3, 6, 7 and 9).
 *
 * An Initiator creates a Game by choosing a Ruleset version, a Map Revision,
 * the number of Players (at most the Map's Spawn Zones), a Point Budget
 * within the Ruleset's range, a time limit and fill timeout (each at most the
 * server's maximum) and a Pace. The Map must not be archived, must be in a
 * Map Format the Ruleset supports, and may use only Terrains the Ruleset
 * defines; Maps are saved without a Ruleset, so this is where that is
 * checked. The Initiator need not enter.
 *
 * Lifecycle: a Game is Open until it is full, when it becomes Running at
 * once (the submission that fills it starts it); the Initiator may cancel it
 * while Open, and it is cancelled automatically if not full by its fill
 * deadline. Running -> Finished is the Game runner's business. The fill
 * timeout is applied lazily before every request here (see db/games.ts),
 * with the deadline as the recorded end time, so it is exact whenever
 * observed.
 *
 * An Entry is one or more of the submitting Player's own, unarchived Bot
 * Design Revisions authored for the Game's Ruleset, each with a Bot Name
 * unique within the Game (ignoring case), costing at most the Point Budget
 * together, and few enough to fit at least one of the Map's Spawn Zones. A
 * Player may submit several Entries to one Game, and may withdraw any of
 * them while the Game is Open. Every check and the insert run in a single
 * transaction, so two submissions racing for the last slot cannot both win.
 *
 * Visibility: every authenticated Player may see any Game and who entered it
 * under which Bot Names. Builds (and costs) are hidden while a Game is Open,
 * and stay hidden if it is Cancelled; from Running onward everyone sees
 * them. An Entry's owner always sees its own Builds and which design
 * Revisions it used. Programs are never shown here.
 */

import { randomUUID } from "node:crypto";
import { checkMapTerrains, entryFitsMap, terrainNames } from "@aumohta/ruleset-data";
import { authenticate } from "../accounts/auth.js";
import {
  botNameKey,
  GAME_STATES,
  PACES,
  type EntryRecord,
  type GameRecord,
  type GameState,
  type NewEntryBot,
  type OpenGameFilters,
  type Pace,
} from "../db/games.js";
import type { MapRevisionRecord } from "../db/maps.js";
import {
  ApiError,
  badRequest,
  forbidden,
  notFound,
  validationFailed,
  type ErrorDetail,
} from "../http/errors.js";
import type { ApiModule, Json, RequestContext } from "../http/router.js";
import type { HostedRuleset } from "../rulesets/catalog.js";

export const BOT_NAME_MAX_LENGTH = 32;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Games";

const gameIdParameter: Json = { name: "gameId", in: "path", required: true, schema: { type: "string" } };
const entryIdParameter: Json = { name: "entryId", in: "path", required: true, schema: { type: "string" } };

const timestamp: Json = { type: "string", format: "date-time" };
const optionalTimestamp: Json = { type: ["string", "null"], format: "date-time" };

const gameProperties: Record<string, Json> = {
  id: { type: "string" },
  state: {
    type: "string",
    enum: [...GAME_STATES],
    description: "open: accepting Entries; running: being simulated; finished: ended with a result; cancelled: ended unplayed.",
  },
  initiator: ref("GamePlayer"),
  rulesetVersion: { type: "string" },
  map: ref("GameMap"),
  playerCount: { type: "integer", minimum: 2, description: "How many Entries fill the Game." },
  pointBudget: { type: "integer", description: "The most points a single Entry may cost." },
  timeLimitSeconds: { type: "integer", minimum: 1, description: "Simulated seconds." },
  pace: { type: "string", enum: [...PACES] },
  fillTimeoutSeconds: { type: "integer", minimum: 1, description: "Real seconds from creation to the fill deadline." },
  createdAt: timestamp,
  fillDeadline: { ...timestamp, description: "When the Game is cancelled if it is not full by then." },
  startedAt: { ...optionalTimestamp, description: "When the Game filled and became Running." },
  endedAt: { ...optionalTimestamp, description: "When the Game was Finished or Cancelled." },
  cancelReason: {
    type: ["string", "null"],
    enum: ["initiator", "fill_timeout", null],
    description: "Why a Cancelled Game was cancelled.",
  },
  entryCount: { type: "integer", minimum: 0 },
};
const gameRequired = Object.keys(gameProperties);

const schemas: Record<string, Json> = {
  GamePlayer: {
    type: "object",
    required: ["id", "username"],
    additionalProperties: false,
    properties: { id: { type: "string" }, username: { type: "string" } },
  },
  GameMap: {
    type: "object",
    description: "The Map Revision the Game is played on.",
    required: ["id", "name", "revision"],
    additionalProperties: false,
    properties: { id: { type: "string" }, name: { type: "string" }, revision: { type: "integer", minimum: 1 } },
  },
  GameSummary: {
    type: "object",
    required: gameRequired,
    additionalProperties: false,
    properties: gameProperties,
  },
  Game: {
    type: "object",
    required: [...gameRequired, "entries"],
    additionalProperties: false,
    properties: { ...gameProperties, entries: { type: "array", items: ref("GameEntry") } },
  },
  GameList: {
    type: "object",
    required: ["games"],
    additionalProperties: false,
    properties: { games: { type: "array", items: ref("GameSummary") } },
  },
  GameEntryBot: {
    type: "object",
    description:
      "One Bot of an Entry. `cost` and `build` are present for your own Entries and, for everyone, once the Game " +
      "is Running or Finished; `design` only for your own Entries. Programs are never included.",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "The Bot Name, unique within the Game." },
      design: {
        type: "object",
        required: ["designId", "revision"],
        additionalProperties: false,
        properties: { designId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
      },
      cost: { type: "integer" },
      build: ref("Build"),
    },
  },
  GameEntry: {
    type: "object",
    description: "`cost` is present for your own Entries and, for everyone, once the Game is Running or Finished.",
    required: ["id", "player", "createdAt", "bots"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      player: ref("GamePlayer"),
      createdAt: timestamp,
      cost: { type: "integer", description: "The combined cost of the Entry's Bots." },
      bots: { type: "array", items: ref("GameEntryBot") },
    },
  },
  NewGame: {
    type: "object",
    required: ["rulesetVersion", "mapId", "playerCount", "pointBudget", "timeLimitSeconds", "pace", "fillTimeoutSeconds"],
    additionalProperties: false,
    properties: {
      rulesetVersion: { type: "string", examples: ["r1"] },
      mapId: { type: "string", description: "An unarchived Map." },
      mapRevision: { type: "integer", minimum: 1, description: "The Map Revision to play on; defaults to the latest." },
      playerCount: { type: "integer", minimum: 2, description: "At most the Map Revision's number of Spawn Zones." },
      pointBudget: { type: "integer", description: "Within the Ruleset's Point Budget range." },
      timeLimitSeconds: { type: "integer", minimum: 1, description: "Simulated seconds, at most the server's maximum." },
      pace: { type: "string", enum: [...PACES] },
      fillTimeoutSeconds: { type: "integer", minimum: 1, description: "Real seconds, at most the server's maximum." },
    },
  },
  NewGameEntryBot: {
    type: "object",
    required: ["designId", "name"],
    additionalProperties: false,
    properties: {
      designId: { type: "string", description: "One of your unarchived Bot Designs, in the Game's Ruleset." },
      revision: { type: "integer", minimum: 1, description: "The Revision to enter; defaults to the latest." },
      name: { type: "string", minLength: 1, maxLength: BOT_NAME_MAX_LENGTH, description: "Unique within the Game, ignoring case." },
    },
  },
  NewGameEntry: {
    type: "object",
    required: ["bots"],
    additionalProperties: false,
    properties: {
      bots: {
        type: "array",
        minItems: 1,
        description: "Entering one design twice yields two Bots; each needs its own name.",
        items: ref("NewGameEntryBot"),
      },
    },
  },
  SubmittedGameEntry: {
    type: "object",
    required: ["entry", "game"],
    additionalProperties: false,
    properties: { entry: ref("GameEntry"), game: ref("Game") },
  },
};

// --- request parsing -------------------------------------------------------

/** Reads a JSON object, reporting fields outside `allowed` and missing `required` ones under `prefix`. */
function readObject(
  body: unknown,
  allowed: readonly string[],
  required: readonly string[],
  prefix = "",
  details?: ErrorDetail[],
): Record<string, unknown> | undefined {
  const local: ErrorDetail[] = [];
  const path = (key: string) => (prefix === "" ? key : `${prefix}.${key}`);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    local.push({ path: prefix === "" ? "(body)" : prefix, message: "must be a JSON object" });
  } else {
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) local.push({ path: path(key), message: "is not a known field" });
    }
    for (const key of required) {
      if (record[key] === undefined) local.push({ path: path(key), message: "is required" });
    }
    if (local.length === 0) return record;
  }
  if (details === undefined) throw validationFailed(local);
  details.push(...local);
  return undefined;
}

/** A required top-level body object; throws listing every field problem. */
function readBody(body: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  // Without a details list, readObject throws rather than returning undefined.
  return readObject(body, allowed, required) ?? {};
}

/** An integer in [min, max], or undefined after recording a problem. */
function readInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
  details: ErrorDetail[],
  why = "",
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    details.push({ path, message: `must be an integer from ${String(min)} to ${String(max)}${why}` });
    return undefined;
  }
  return value;
}

function readRuleset(context: RequestContext, value: unknown, details: ErrorDetail[]): HostedRuleset | undefined {
  if (typeof value !== "string") {
    details.push({ path: "rulesetVersion", message: "must be a string" });
    return undefined;
  }
  const hosted = context.services.rulesets.get(value);
  if (hosted === undefined) {
    const known = context.services.rulesets.versions().join(", ");
    details.push({ path: "rulesetVersion", message: `is not a Ruleset version this server hosts (${known})` });
  }
  return hosted;
}

function readPace(value: unknown, details: ErrorDetail[]): Pace | undefined {
  if (typeof value === "string" && (PACES as readonly string[]).includes(value)) return value as Pace;
  details.push({ path: "pace", message: `must be one of ${PACES.join(", ")}` });
  return undefined;
}

/** The Map Revision a new Game would use, or undefined after recording problems. */
function readMapRevision(
  context: RequestContext,
  mapId: unknown,
  revision: unknown,
  details: ErrorDetail[],
): MapRevisionRecord | undefined {
  if (typeof mapId !== "string") {
    details.push({ path: "mapId", message: "must be a string" });
    return undefined;
  }
  const maps = context.services.db.maps;
  const map = maps.getMap(mapId);
  if (map === undefined) {
    details.push({ path: "mapId", message: "is not a Map" });
    return undefined;
  }
  if (map.archivedAt !== null) {
    details.push({ path: "mapId", message: "is an archived Map, which new Games cannot use" });
    return undefined;
  }
  let number = map.latestRevision.number;
  if (revision !== undefined) {
    const read = readInteger(revision, "mapRevision", 1, map.latestRevision.number, details);
    if (read === undefined) return undefined;
    number = read;
  }
  const found = maps.getRevision(mapId, number);
  if (found === undefined) details.push({ path: "mapRevision", message: `is not a Revision of Map ${mapId}` });
  return found;
}

/** Problems with playing this Map Revision under this Ruleset. */
function mapRulesetProblems(hosted: HostedRuleset, revision: MapRevisionRecord): ErrorDetail[] {
  const ruleset = hosted.ruleset;
  if (!ruleset.mapFormats.includes(revision.map.format)) {
    return [
      {
        path: "mapRevision",
        message:
          `is in Map Format ${String(revision.map.format)}, which Ruleset ${ruleset.version} does not support ` +
          `(it supports ${ruleset.mapFormats.join(", ")})`,
      },
    ];
  }
  return checkMapTerrains(revision.map, terrainNames(ruleset)).map((e) => ({
    path: "mapRevision",
    message: `${e.path} ${e.message} under Ruleset ${ruleset.version}`,
  }));
}

/** A trimmed Bot Name, or undefined after recording a problem. */
function readBotName(value: unknown, path: string, details: ErrorDetail[]): string | undefined {
  if (typeof value !== "string") {
    details.push({ path, message: "must be a string" });
    return undefined;
  }
  const name = value.trim();
  if (name.length === 0 || name.length > BOT_NAME_MAX_LENGTH || /\p{Cc}/u.test(name)) {
    details.push({
      path,
      message: `must be 1 to ${String(BOT_NAME_MAX_LENGTH)} characters, without control characters`,
    });
    return undefined;
  }
  return name;
}

/** A non-negative integer query parameter, or undefined if absent. */
function queryInteger(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  return Number(raw);
}

// --- responses -------------------------------------------------------------

const buildsVisible = (game: GameRecord): boolean => game.state === "running" || game.state === "finished";

const gameFields = (g: GameRecord): Record<string, Json> => ({
  id: g.id,
  state: g.state,
  initiator: { id: g.initiator.id, username: g.initiator.username },
  rulesetVersion: g.rulesetVersion,
  map: { id: g.map.id, name: g.map.name, revision: g.map.revision },
  playerCount: g.playerCount,
  pointBudget: g.pointBudget,
  timeLimitSeconds: g.timeLimitSeconds,
  pace: g.pace,
  fillTimeoutSeconds: g.fillTimeoutSeconds,
  createdAt: g.createdAt,
  fillDeadline: g.fillDeadline,
  startedAt: g.startedAt,
  endedAt: g.endedAt,
  cancelReason: g.cancelReason,
  entryCount: g.entryCount,
});

/** An Entry as `viewerId` may see it in `game`. */
function entryJson(entry: EntryRecord, game: GameRecord, viewerId: string): Json {
  const own = entry.player.id === viewerId;
  const visible = own || buildsVisible(game);
  return {
    id: entry.id,
    player: { id: entry.player.id, username: entry.player.username },
    createdAt: entry.createdAt,
    ...(visible ? { cost: entry.cost } : {}),
    bots: entry.bots.map((bot) => ({
      name: bot.name,
      ...(own ? { design: { designId: bot.designId, revision: bot.revision } } : {}),
      ...(visible
        ? {
            cost: bot.cost,
            build: { chassis: bot.build.chassis, components: { ...bot.build.components }, armor: { ...bot.build.armor } },
          }
        : {}),
    })),
  };
}

function gameJson(context: RequestContext, game: GameRecord, viewerId: string): Json {
  const entries = context.services.db.games.listEntries(game.id);
  return { ...gameFields(game), entries: entries.map((e) => entryJson(e, game, viewerId)) };
}

const noGame = (id: string): ApiError => notFound(`There is no Game ${id}`);

const notOpen = (id: string, state: GameState): ApiError =>
  new ApiError(409, "game_not_open", `Game ${id} is ${state}, not open`);

/** Applies fill timeouts, so every Game read afterwards is up to date. */
function sweep(context: RequestContext): Date {
  const now = context.services.clock();
  context.services.db.games.expireOpenGames(now);
  return now;
}

function loadGame(context: RequestContext): GameRecord {
  const id = context.params.gameId ?? "";
  const game = context.services.db.games.getGame(id);
  if (game === undefined) throw noGame(id);
  return game;
}

// --- the module ------------------------------------------------------------

export const gamesModule: ApiModule = {
  tags: [
    {
      name: TAG,
      description:
        "Creating Games, browsing Open ones, and submitting or withdrawing Entries. A Game starts by itself the " +
        "moment it is full and is cancelled by itself if not full by its fill deadline. Builds stay hidden " +
        "while a Game is Open; Programs are never shown.",
    },
  ],
  schemas,
  routes: [
    {
      method: "POST",
      path: "/games",
      operation: {
        operationId: "createGame",
        summary: "Create an Open Game",
        description:
          "You become its Initiator; you need not enter it. The Map must not be archived, its Revision must be " +
          "in a Map Format the Ruleset supports and use only Terrains the Ruleset defines, and `playerCount` may " +
          "not exceed its Spawn Zones. `pointBudget` must be within the Ruleset's range, and `timeLimitSeconds` " +
          "and `fillTimeoutSeconds` within the server's maxima. Every problem is listed in `details`.",
        tags: [TAG],
        security: bearer,
        requestBody: { required: true, content: jsonContent(ref("NewGame")) },
        responses: {
          "201": { description: "The new Game, Open with no Entries.", content: jsonContent(ref("Game")) },
          "401": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const required = [
          "rulesetVersion",
          "mapId",
          "playerCount",
          "pointBudget",
          "timeLimitSeconds",
          "pace",
          "fillTimeoutSeconds",
        ];
        const body = readBody(await context.readJson(), [...required, "mapRevision"], required);
        const limits = context.services.config.limits;
        const details: ErrorDetail[] = [];

        const hosted = readRuleset(context, body.rulesetVersion, details);
        const revision = readMapRevision(context, body.mapId, body.mapRevision, details);
        if (hosted !== undefined && revision !== undefined) details.push(...mapRulesetProblems(hosted, revision));
        const playerCount = readInteger(
          body.playerCount,
          "playerCount",
          2,
          revision?.map.spawnZones.length ?? Number.MAX_SAFE_INTEGER,
          details,
          revision === undefined ? "" : " (the Map Revision's Spawn Zones)",
        );
        const budget = hosted?.ruleset.pointBudget;
        const pointBudget = readInteger(
          body.pointBudget,
          "pointBudget",
          budget?.min ?? 1,
          budget?.max ?? Number.MAX_SAFE_INTEGER,
          details,
          hosted === undefined ? "" : ` (Ruleset ${hosted.ruleset.version}'s Point Budget range)`,
        );
        const timeLimitSeconds = readInteger(body.timeLimitSeconds, "timeLimitSeconds", 1, limits.maxTimeLimitSeconds, details);
        const pace = readPace(body.pace, details);
        const fillTimeoutSeconds = readInteger(
          body.fillTimeoutSeconds,
          "fillTimeoutSeconds",
          1,
          limits.maxFillTimeoutSeconds,
          details,
        );
        if (
          details.length > 0 ||
          hosted === undefined ||
          revision === undefined ||
          playerCount === undefined ||
          pointBudget === undefined ||
          timeLimitSeconds === undefined ||
          pace === undefined ||
          fillTimeoutSeconds === undefined
        ) {
          throw validationFailed(details);
        }

        const game = context.services.db.games.createGame(
          {
            id: randomUUID(),
            initiatorId: player.id,
            rulesetVersion: hosted.ruleset.version,
            mapId: revision.mapId,
            mapRevision: revision.number,
            playerCount,
            pointBudget,
            timeLimitSeconds,
            pace,
            fillTimeoutSeconds,
          },
          context.services.clock(),
        );
        return { status: 201, body: gameJson(context, game, player.id) };
      },
    },
    {
      method: "GET",
      path: "/games",
      operation: {
        operationId: "listOpenGames",
        summary: "Browse Open Games",
        description: "Only Open Games are listed, newest first, filtered by every parameter given.",
        tags: [TAG],
        security: bearer,
        parameters: [
          { name: "rulesetVersion", in: "query", required: false, schema: { type: "string" } },
          { name: "mapId", in: "query", required: false, schema: { type: "string" } },
          { name: "playerCount", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
          {
            name: "minPointBudget",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0 },
            description: "Only Games whose Point Budget is at least this.",
          },
          {
            name: "maxPointBudget",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 0 },
            description: "Only Games whose Point Budget is at most this.",
          },
        ],
        responses: {
          "200": { description: "Open Games.", content: jsonContent(ref("GameList")) },
          "400": errorResponse,
          "401": errorResponse,
        },
      },
      handler: (context) => {
        authenticate(context);
        const query = context.url.searchParams;
        const rulesetVersion = query.get("rulesetVersion");
        const mapId = query.get("mapId");
        const playerCount = queryInteger(query, "playerCount");
        const minPointBudget = queryInteger(query, "minPointBudget");
        const maxPointBudget = queryInteger(query, "maxPointBudget");
        const filters: OpenGameFilters = {
          ...(rulesetVersion === null ? {} : { rulesetVersion }),
          ...(mapId === null ? {} : { mapId }),
          ...(playerCount === undefined ? {} : { playerCount }),
          ...(minPointBudget === undefined ? {} : { minPointBudget }),
          ...(maxPointBudget === undefined ? {} : { maxPointBudget }),
        };
        sweep(context);
        return { body: { games: context.services.db.games.listOpenGames(filters).map(gameFields) } };
      },
    },
    {
      method: "GET",
      path: "/players/me/games",
      operation: {
        operationId: "listMyGames",
        summary: "List the Games you initiated or entered",
        description: "Newest first, in any state unless `state` is given.",
        tags: [TAG],
        security: bearer,
        parameters: [
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: `Comma-separated states to include, from ${GAME_STATES.join(", ")}.`,
            examples: { live: { value: "open,running" } },
          },
        ],
        responses: {
          "200": { description: "Your Games.", content: jsonContent(ref("GameList")) },
          "400": errorResponse,
          "401": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const raw = context.url.searchParams.get("state");
        let states: GameState[] | undefined;
        if (raw !== null) {
          const parts = raw.split(",");
          if (!parts.every((s) => (GAME_STATES as readonly string[]).includes(s))) {
            throw badRequest(`state must be a comma-separated list of ${GAME_STATES.join(", ")}`);
          }
          states = parts as GameState[];
        }
        sweep(context);
        return { body: { games: context.services.db.games.listPlayerGames(player.id, states).map(gameFields) } };
      },
    },
    {
      method: "GET",
      path: "/games/{gameId}",
      operation: {
        operationId: "getGame",
        summary: "Get a Game with its Entries",
        description:
          "Any Player may read any Game. Other Players' Builds are hidden while the Game is Open (and if it was " +
          "Cancelled); Programs are never shown.",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        responses: {
          "200": { description: "The Game.", content: jsonContent(ref("Game")) },
          "401": errorResponse,
          "404": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        sweep(context);
        return { body: gameJson(context, loadGame(context), player.id) };
      },
    },
    {
      method: "POST",
      path: "/games/{gameId}/cancel",
      operation: {
        operationId: "cancelGame",
        summary: "Cancel an Open Game you initiated",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        responses: {
          "200": { description: "The Cancelled Game.", content: jsonContent(ref("Game")) },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        const now = sweep(context);
        const id = context.params.gameId ?? "";
        const result = context.services.db.games.cancelGame(player.id, id, now);
        if (result === "not_found") throw noGame(id);
        if (result === "not_initiator") throw forbidden(`Only the Initiator of Game ${id} can cancel it`);
        if ("notOpen" in result) throw notOpen(id, result.notOpen);
        return { body: gameJson(context, result, player.id) };
      },
    },
    {
      method: "POST",
      path: "/games/{gameId}/entries",
      operation: {
        operationId: "submitGameEntry",
        summary: "Submit an Entry to an Open Game",
        description:
          "Each Bot is one of your unarchived Bot Designs (at a given Revision, the latest by default) authored " +
          "for the Game's Ruleset, with a Bot Name unique within the Game ignoring case. Together they must cost " +
          "at most the Point Budget and be few enough for at least one of the Map's Spawn Zones. You may submit " +
          "several Entries to one Game. The Entry that fills the Game starts it: it is Running in the response. " +
          "If the Game is no longer Open (it filled, was cancelled or timed out) the answer is 409 `game_not_open`.",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        requestBody: { required: true, content: jsonContent(ref("NewGameEntry")) },
        responses: {
          "201": { description: "The new Entry and the Game.", content: jsonContent(ref("SubmittedGameEntry")) },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
          "422": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const body = readBody(await context.readJson(), ["bots"], ["bots"]);
        const { db } = context.services;
        const now = sweep(context);
        // Everything from here on is synchronous in one transaction, so no
        // other request can take the slot or a Bot Name in between.
        return db.transaction(() => {
          const game = loadGame(context);
          if (game.state !== "open") throw notOpen(game.id, game.state);
          const map = db.maps.getRevision(game.map.id, game.map.revision);
          if (map === undefined) throw new Error(`Game ${game.id} references a missing Map Revision`);

          const details: ErrorDetail[] = [];
          const bots: NewEntryBot[] = [];
          let cost = 0;
          const keys = new Set<string>();
          if (!Array.isArray(body.bots) || body.bots.length === 0) {
            details.push({ path: "bots", message: "must be a non-empty array" });
          } else {
            (body.bots as unknown[]).forEach((item, i) => {
              const at = `bots[${String(i)}]`;
              const fields = readObject(item, ["designId", "revision", "name"], ["designId", "name"], at, details);
              if (fields === undefined) return;
              const name = readBotName(fields.name, `${at}.name`, details);
              if (name !== undefined) {
                if (keys.has(botNameKey(name))) details.push({ path: `${at}.name`, message: "is already used in this Entry" });
                keys.add(botNameKey(name));
              }
              if (typeof fields.designId !== "string") {
                details.push({ path: `${at}.designId`, message: "must be a string" });
                return;
              }
              const design = db.garage.getDesign(player.id, fields.designId);
              if (design === undefined) {
                details.push({ path: `${at}.designId`, message: "is not one of your Bot Designs" });
                return;
              }
              if (design.archivedAt !== null) {
                details.push({ path: `${at}.designId`, message: "is an archived Bot Design, which new Entries cannot use" });
                return;
              }
              if (design.rulesetVersion !== game.rulesetVersion) {
                details.push({
                  path: `${at}.designId`,
                  message: `is authored for Ruleset ${design.rulesetVersion}, but this Game uses ${game.rulesetVersion}`,
                });
                return;
              }
              let number = design.latestRevision.number;
              if (fields.revision !== undefined) {
                const read = readInteger(fields.revision, `${at}.revision`, 1, design.latestRevision.number, details);
                if (read === undefined) return;
                number = read;
              }
              const revision = db.garage.getRevision(player.id, design.id, number);
              if (revision === undefined) {
                details.push({ path: `${at}.revision`, message: `is not a Revision of Bot Design ${design.id}` });
                return;
              }
              cost += revision.cost;
              if (name !== undefined) bots.push({ name, designId: design.id, revision: number });
            });
            const count = body.bots.length;
            if (!entryFitsMap(map.map, count)) {
              const largest = Math.max(...map.map.spawnZones.map((z) => z.capacity));
              details.push({
                path: "bots",
                message: `has ${String(count)} Bots, more than any Spawn Zone of this Map holds (at most ${String(largest)})`,
              });
            }
            if (cost > game.pointBudget) {
              details.push({
                path: "bots",
                message: `cost ${String(cost)} points, more than this Game's Point Budget of ${String(game.pointBudget)}`,
              });
            }
          }
          if (details.length > 0) throw validationFailed(details);

          const entryId = randomUUID();
          const result = db.games.addEntry(game.id, { id: entryId, playerId: player.id, cost, bots }, now);
          if ("kind" in result) {
            switch (result.kind) {
              case "not_found":
                throw noGame(game.id);
              case "not_open":
                throw notOpen(game.id, result.state);
              case "full":
                throw new ApiError(409, "game_not_open", `Game ${game.id} is full`);
              case "name_taken": {
                const clashing = new Set(result.names.map(botNameKey));
                throw validationFailed(
                  bots.flatMap((b, i) =>
                    clashing.has(botNameKey(b.name))
                      ? [{ path: `bots[${String(i)}].name`, message: "is already taken in this Game" }]
                      : [],
                  ),
                );
              }
            }
          }
          const entry = db.games.listEntries(game.id).find((e) => e.id === entryId);
          if (entry === undefined) throw new Error(`Entry ${entryId} vanished while being submitted`);
          return {
            status: 201,
            body: { entry: entryJson(entry, result, player.id), game: gameJson(context, result, player.id) },
          };
        });
      },
    },
    {
      method: "DELETE",
      path: "/games/{gameId}/entries/{entryId}",
      operation: {
        operationId: "withdrawGameEntry",
        summary: "Withdraw one of your Entries from an Open Game",
        description: "The Entry is removed and its slot freed. Once a Game has started, Entries cannot be withdrawn.",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter, entryIdParameter],
        responses: {
          "204": { description: "Withdrawn." },
          "401": errorResponse,
          "403": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: (context) => {
        const { player } = authenticate(context);
        sweep(context);
        const gameId = context.params.gameId ?? "";
        const entryId = context.params.entryId ?? "";
        const result = context.services.db.games.withdrawEntry(player.id, gameId, entryId);
        if (result === "not_found") throw notFound(`Game ${gameId} has no Entry ${entryId}`);
        if (result === "not_owner") throw forbidden(`Entry ${entryId} is not yours to withdraw`);
        if (result !== true) throw notOpen(gameId, result.notOpen);
        return {};
      },
    },
  ],
};

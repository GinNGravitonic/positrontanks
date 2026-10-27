/**
 * Spectating: snapshots, the live stream, Replays and Program logs (spec
 * sections 8 and 9).
 *
 * Any authenticated Player may watch any Game once it is Running: a snapshot
 * gives the latest Tick, and the event stream (Server-Sent Events) starts
 * with a snapshot and then delivers every Tick as it is played, ending once
 * the Game is Finished. After the Game, anyone may fetch its Replay. All of
 * these carry Builds, which everyone may see from Running onward (see
 * games.ts), and never Programs. Open and Cancelled Games have nothing to
 * watch, so their Builds stay hidden.
 *
 * Snapshots and the stream speak in Replay terms: a snapshot is the Replay
 * header with only the latest Tick in `ticks`, and each `tick` event is one
 * more Tick for it, so a client that appends them holds the Replay from the
 * moment it joined.
 *
 * A Bot's Program log (runtime errors, halts, budget use and `log()` output)
 * goes only to its owner: a Player reads the logs of their own Bots in a
 * Game, never anyone else's.
 *
 * Running Games are read from the Game runner while it plays them; Finished
 * ones from what it stored. A Running Game the runner has not started yet
 * (it is waiting for an unthrottled slot, or being resumed after a restart)
 * has no snapshot yet; the stream simply waits for it.
 */

import { authenticate } from "../accounts/auth.js";
import type { GameRecord } from "../db/games.js";
import type { ProgramLogData, ReplayData } from "../games/engine.js";
import { programLogsKey, replayKey } from "../games/runner.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import type { ApiModule, Json, RequestContext } from "../http/router.js";
import { gameJson, loadGame, sweep } from "./games.js";

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: Json): Json => ({ "application/json": { schema } });
const errorResponse: Json = { $ref: "#/components/responses/Error" };
const bearer: readonly Json[] = [{ bearerAuth: [] }];
const TAG = "Spectating";

const gameIdParameter: Json = { name: "gameId", in: "path", required: true, schema: { type: "string" } };

const schemas: Record<string, Json> = {
  ReplayTick: {
    type: "object",
    description: "One Tick of a Replay: what happened in it, and where everything was at its end.",
    required: ["tick", "events", "bots", "projectiles"],
    properties: {
      tick: { type: "integer", minimum: 0, description: "0 for the init phase, whose frame shows the starting positions." },
      events: {
        type: "array",
        description:
          "In the order they happened. Each has a `type` (collision, fired, impact, damage, disabled, " +
          "obstacleDestroyed) and that type's fields, as the Ruleset version's engine spec describes.",
        items: {
          type: "object",
          required: ["type", "tick"],
          properties: { type: { type: "string" }, tick: { type: "integer", minimum: 0 } },
        },
      },
      bots: {
        type: "array",
        description: "Every Bot, in Bot id order.",
        items: {
          type: "object",
          required: ["id", "x", "y", "heading", "speed", "hitPoints", "status"],
          properties: {
            id: { type: "integer", minimum: 1 },
            x: { type: "number" },
            y: { type: "number" },
            heading: { type: "number", description: "Degrees." },
            speed: { type: "number", description: "m/s." },
            hitPoints: { type: "number" },
            status: { type: "string", enum: ["active", "stopped", "disabled"] },
          },
        },
      },
      projectiles: {
        type: "array",
        description: "Projectiles in flight, in id order.",
        items: {
          type: "object",
          required: ["id", "x", "y"],
          properties: { id: { type: "integer" }, x: { type: "number" }, y: { type: "number" } },
        },
      },
    },
  },
  Replay: {
    type: "object",
    description:
      "A Game's full history of events plus every participating Build, never a Program. The shape is the " +
      "Ruleset version's; this describes r1.",
    required: ["ruleset", "tickRate", "map", "timeLimitTicks", "entries", "ticks", "result"],
    properties: {
      ruleset: { type: "string", description: "The Ruleset version." },
      tickRate: { type: "integer", description: "Ticks per simulated second." },
      map: ref("MapFormat1"),
      timeLimitTicks: { type: "integer" },
      entries: {
        type: "array",
        description: "In Entry order.",
        items: {
          type: "object",
          required: ["player", "bots"],
          properties: {
            player: { type: "string", description: "The Player's id." },
            bots: {
              type: "array",
              description: "In Bot id order; Bot ids are numbered from 1 across all Entries.",
              items: {
                type: "object",
                required: ["id", "name", "build"],
                properties: { id: { type: "integer", minimum: 1 }, name: { type: "string" }, build: ref("Build") },
              },
            },
          },
        },
      },
      ticks: { type: "array", description: "Every Tick, from the init phase (Tick 0).", items: ref("ReplayTick") },
      result: {
        type: ["object", "null"],
        description: "How the Game ended, with Players by id; null while it is Running.",
        required: ["tick", "end", "winner", "decidedBy", "standings"],
        properties: {
          tick: { type: "integer", minimum: 0 },
          end: { type: "string", enum: ["lastStanding", "noneStanding", "timeLimit"] },
          winner: { type: ["string", "null"], description: "The winning Player's id; null for a Draw." },
          decidedBy: { type: ["string", "null"], enum: ["survival", "foeDamage", "hitPoints", null] },
          standings: {
            type: "array",
            description: "One per Player, in order of their first Entry.",
            items: {
              type: "object",
              required: ["player", "foeDamage", "hitPoints", "remaining"],
              properties: {
                player: { type: "string" },
                foeDamage: { type: "number" },
                hitPoints: { type: "number" },
                remaining: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
  GameSnapshot: {
    type: "object",
    description: "A Game and its Replay so far, with only the latest Tick in `replay.ticks`.",
    required: ["game", "replay"],
    additionalProperties: false,
    properties: { game: ref("Game"), replay: ref("Replay") },
  },
  GameReplay: {
    type: "object",
    required: ["game", "replay"],
    additionalProperties: false,
    properties: { game: ref("Game"), replay: ref("Replay") },
  },
  GameEnded: {
    type: "object",
    description: "The `end` event's data: the Game, now Finished, with its result.",
    required: ["game"],
    additionalProperties: false,
    properties: { game: ref("Game") },
  },
  ProgramLogs: {
    type: "object",
    required: ["bots"],
    additionalProperties: false,
    properties: {
      bots: {
        type: "array",
        description: "Your Bots in the Game, in Bot id order.",
        items: {
          type: "object",
          required: ["bot", "name", "runs"],
          additionalProperties: false,
          properties: {
            bot: { type: "integer", minimum: 1, description: "The Bot's id in the Replay." },
            name: { type: "string", description: "The Bot Name." },
            runs: {
              type: "array",
              description: "Every run of the Program in the Ticks asked for, in Tick order; Tick 0 is the init phase.",
              items: {
                type: "object",
                required: ["tick", "result"],
                additionalProperties: false,
                properties: {
                  tick: { type: "integer", minimum: 0 },
                  result: {
                    type: "object",
                    required: ["outcome", "error", "operations", "memoryCells", "halt", "log", "logTruncated"],
                    properties: {
                      outcome: { type: "string", enum: ["completed", "outOfBudget", "error"] },
                      error: {
                        type: ["object", "null"],
                        description: "Where and why the run stopped early, or null.",
                        required: ["line", "column", "message"],
                        properties: { line: { type: "integer" }, column: { type: "integer" }, message: { type: "string" } },
                      },
                      operations: { type: "integer", description: "Operations charged during the run." },
                      memoryCells: { type: "integer", description: "Persistent state at the end of the run, in cells." },
                      halt: { type: ["string", "null"], description: "Why the Program halted after this run, or null." },
                      log: { type: "array", items: { type: "string" }, description: "`log()` output, capped by the Ruleset." },
                      logTruncated: { type: "boolean", description: "Whether `log()` output was dropped for this run." },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// --- helpers ---------------------------------------------------------------

const notStarted = (game: GameRecord): ApiError =>
  game.state === "cancelled"
    ? new ApiError(409, "game_cancelled", `Game ${game.id} was cancelled; it was never played`)
    : new ApiError(409, "game_not_started", `Game ${game.id} has not started yet`);

/** The Game is Running, but the runner has not started (or resumed) playing it yet. */
const waiting = (game: GameRecord): ApiError =>
  new ApiError(
    409,
    "game_not_started",
    `Game ${game.id} is Running but waiting to be played (for a free slot, or while the server resumes it); try again shortly`,
  );

/** A Game Running or Finished, the states with something to watch. */
function watchableGame(context: RequestContext): GameRecord {
  sweep(context);
  const game = loadGame(context);
  if (game.state === "open" || game.state === "cancelled") throw notStarted(game);
  return game;
}

/** A Game as `viewerId` sees it now. */
function currentGame(context: RequestContext, id: string, viewerId: string): Json {
  const game = context.services.db.games.getGame(id);
  if (game === undefined) throw new Error(`Game ${id} vanished`);
  return gameJson(context, game, viewerId);
}

async function storedJson(context: RequestContext, key: string): Promise<unknown> {
  const data = await context.services.objects.get(key);
  if (data === undefined) throw new Error(`Nothing is stored at ${key}`);
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

/** A Finished Game's stored Replay. */
const storedReplay = async (context: RequestContext, game: GameRecord): Promise<ReplayData> =>
  (await storedJson(context, replayKey(game.id))) as ReplayData;

/** The Replay with only its latest Tick. */
function latest(replay: ReplayData): ReplayData {
  const last = replay.ticks.at(-1);
  return { ...replay, ticks: last === undefined ? [] : [last] };
}

/** The latest Tick's number, as the snapshot event's id. */
const latestTick = (replay: ReplayData): string => String(replay.ticks.at(-1)?.tick ?? 0);

/** An inclusive Tick bound from the query string, or the default. */
function queryTick(context: RequestContext, name: string, fallback: number): number {
  const raw = context.url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  return Number(raw);
}

// --- the module ------------------------------------------------------------

export const spectatingModule: ApiModule = {
  tags: [
    {
      name: TAG,
      description:
        "Watching Games: the latest Tick, a live stream of every Tick, and the Replay once a Game is Finished. Any " +
        "authenticated Player may watch any Game from Running onward. Programs are never shown; a Bot's Program " +
        "log goes only to its owner.",
    },
  ],
  schemas,
  routes: [
    {
      method: "GET",
      path: "/games/{gameId}/snapshot",
      operation: {
        operationId: "getGameSnapshot",
        summary: "Get the latest Tick of a Running or Finished Game",
        description:
          "The Game, and its Replay header with only the latest Tick played in `replay.ticks` (the last Tick, " +
          "once Finished). Open Games answer 409 `game_not_started`, as do Running Games the server has not " +
          "started playing yet; Cancelled Games answer 409 `game_cancelled`.",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        responses: {
          "200": { description: "The snapshot.", content: jsonContent(ref("GameSnapshot")) },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const game = watchableGame(context);
        let replay: ReplayData;
        if (game.state === "finished") {
          replay = await storedReplay(context, game);
        } else {
          const live = context.services.runner.replay(game.id);
          if (live === undefined) throw waiting(game);
          replay = live;
        }
        return { body: { game: gameJson(context, game, player.id), replay: latest(replay) } };
      },
    },
    {
      method: "GET",
      path: "/games/{gameId}/stream",
      operation: {
        operationId: "streamGame",
        summary: "Watch a Game live, one event per Tick (Server-Sent Events)",
        description:
          "A `text/event-stream` of JSON events. First a `snapshot` (a GameSnapshot), sent as soon as the Game " +
          "is being played; then a `tick` (a ReplayTick) for every Tick played after it, in order, with the Tick " +
          "as the event id; then, once the Game is Finished, an `end` (a GameEnded) and the stream closes. A " +
          "Finished Game gives its last snapshot and `end` at once. If the stream closes without `end` (the " +
          "server is restarting, or you read too slowly and fell too far behind), reconnect: you get a fresh " +
          "snapshot. Comment lines keep idle streams open. Open and Cancelled Games answer 409 as for the " +
          "snapshot. Browsers must read the stream with `fetch` (a ReadableStream body, sending the bearer " +
          "`Authorization` header), since the native EventSource cannot send it; on reconnect, send the last " +
          "event id as `Last-Event-ID`, as EventSource would (the server answers with a fresh snapshot " +
          "regardless).",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        responses: {
          "200": {
            description:
              "The event stream. Its `data` lines are GameSnapshot (`snapshot`), ReplayTick (`tick`) and GameEnded " +
              "(`end`) JSON.",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const game = watchableGame(context);
        if (game.state === "finished") {
          const replay = await storedReplay(context, game);
          const ended = gameJson(context, game, player.id);
          return {
            events: (sink) => {
              sink.send({ event: "snapshot", id: latestTick(replay), data: { game: ended, replay: latest(replay) } });
              sink.send({ event: "end", data: { game: ended } });
              sink.close();
              return () => undefined;
            },
          };
        }
        // Running: the runner sends the snapshot when it adds the watcher (or starts the Game) and every
        // Tick after it, so none is missed. If the Game Finished in the meantime the stream just closes,
        // and the client reconnects to the Finished Game.
        return {
          events: (sink) =>
            context.services.runner.watch(game.id, (event) => {
              switch (event.kind) {
                case "started":
                  sink.send({
                    event: "snapshot",
                    id: latestTick(event.replay),
                    data: { game: currentGame(context, game.id, player.id), replay: latest(event.replay) },
                  });
                  break;
                case "tick":
                  sink.send({ event: "tick", id: String(event.frame.tick), data: event.frame });
                  break;
                case "finished":
                  sink.send({ event: "end", data: { game: currentGame(context, game.id, player.id) } });
                  sink.close();
                  break;
                case "stopped":
                  sink.close();
                  break;
              }
            }),
        };
      },
    },
    {
      method: "GET",
      path: "/games/{gameId}/replay",
      operation: {
        operationId: "getGameReplay",
        summary: "Get the Replay of a Finished Game",
        description:
          "Every Tick's events and positions, and every participating Build; never a Program. Games not yet " +
          "Finished answer 409 `game_not_finished`; Cancelled Games, which have no Replay, 409 `game_cancelled`.",
        tags: [TAG],
        security: bearer,
        parameters: [gameIdParameter],
        responses: {
          "200": { description: "The Game and its Replay.", content: jsonContent(ref("GameReplay")) },
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        sweep(context);
        const game = loadGame(context);
        if (game.state === "cancelled") throw notStarted(game);
        if (game.state !== "finished") {
          throw new ApiError(409, "game_not_finished", `Game ${game.id} is ${game.state}; its Replay comes once it is Finished`);
        }
        return { body: { game: gameJson(context, game, player.id), replay: await storedReplay(context, game) } };
      },
    },
    {
      method: "GET",
      path: "/games/{gameId}/program-logs",
      operation: {
        operationId: "getMyProgramLogs",
        summary: "Get your own Bots' Program logs in a Game",
        description:
          "Runtime errors, halts, operations used and `log()` output of each of your Bots' Program runs, so far " +
          "while the Game is Running. Only your own Bots are ever included; if you have none in the Game the " +
          "answer is 404. Narrow it with `fromTick` and `toTick` (inclusive) to page through a long Game or poll " +
          "a live one. Open and Cancelled Games answer 409 as for the snapshot.",
        tags: [TAG],
        security: bearer,
        parameters: [
          gameIdParameter,
          { name: "fromTick", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
          { name: "toTick", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
        ],
        responses: {
          "200": { description: "Your Bots' Program logs.", content: jsonContent(ref("ProgramLogs")) },
          "400": errorResponse,
          "401": errorResponse,
          "404": errorResponse,
          "409": errorResponse,
        },
      },
      handler: async (context) => {
        const { player } = authenticate(context);
        const fromTick = queryTick(context, "fromTick", 0);
        const toTick = queryTick(context, "toTick", Number.MAX_SAFE_INTEGER);
        sweep(context);
        const game = loadGame(context);
        if (!context.services.db.games.listEntries(game.id).some((e) => e.player.id === player.id)) {
          throw notFound(`You have no Bots in Game ${game.id}`);
        }
        if (game.state === "open" || game.state === "cancelled") throw notStarted(game);
        let logs: readonly ProgramLogData[];
        if (game.state === "finished") {
          logs = (await storedJson(context, programLogsKey(game.id, player.id))) as ProgramLogData[];
        } else {
          const live = context.services.runner.programLogs(game.id, player.id);
          if (live === undefined) throw waiting(game);
          logs = live;
        }
        return {
          body: {
            bots: logs.map((log) => ({
              bot: log.bot,
              name: log.name,
              runs: log.runs.filter((run) => run.tick >= fromTick && run.tick <= toTick),
            })),
          },
        };
      },
    },
  ],
};

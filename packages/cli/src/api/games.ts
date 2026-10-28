/**
 * `aumohta games` (docs/spec/cli-api.md): Games, Entries and spectating.
 *
 * `games create` defaults match `aumohta run` where the two overlap.
 * `games watch` follows the event stream until the Game ends, reconnecting
 * when it closes early, and can write the Replay assembled from it.
 */

import type { GameResult as EngineResult } from "@aumohta/engine-r1";
import { formatResult, table } from "../report.js";
import { CliError, EXIT, fetchList, NOT_AUTHENTICATED_MESSAGE, parseJson, usageError, type Schema } from "./client.js";
import {
  ago,
  emit,
  flag,
  moreHint,
  optionalNumber,
  PAGE_OPTIONS,
  pageOptions,
  readJsonInput,
  rulesetOrLatest,
  segment,
  str,
  strs,
  wholeNumber,
  writeOutput,
  type Context,
  type Group,
  type Values,
} from "./context.js";
import { readEvents, type StreamEvent } from "./sse.js";

type Game = Schema<"Game">;
type GameSummary = Schema<"GameSummary">;
type GameResult = Schema<"GameResult">;
type Replay = Schema<"Replay">;
type ReplayTick = Schema<"ReplayTick">;
type GameSnapshot = Schema<"GameSnapshot">;

/** `games create` defaults, as `aumohta run`'s. */
const DEFAULT_PLAYERS = 2;
const DEFAULT_TIME_LIMIT_SECONDS = 120;
const DEFAULT_FILL_TIMEOUT_SECONDS = 3600;

/** `games watch`: the waits before each reconnect in a row, and `--wait`'s polling interval. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000];
export const WAIT_POLL_MS = 5000;

const gamePath = (id: string) => `/games/${segment(id)}`;

/** Fails with exit code 3 before sending anything when there is no credential. */
function needKey(context: Context): void {
  if (context.client.apiKey === undefined) throw new CliError(EXIT.notAuthenticated, "not_authenticated", NOT_AUTHENTICATED_MESSAGE);
}

const sleeper = (context: Context) => context.io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const PACE_TEXT: Record<Game["pace"], string> = { realtime: "real time", unthrottled: "unthrottled" };
const END_TEXT: Record<GameResult["end"], string> = { last_standing: "last standing", none_standing: "none standing", time_limit: "time limit" };
const DECIDED_TEXT: Record<NonNullable<GameResult["decidedBy"]>, string> = {
  survival: "by survival",
  foe_damage: "on Foe damage",
  hit_points: "on remaining Hit Points",
};

const entriesText = (g: GameSummary) => `${String(g.entryCount)}/${String(g.playerCount)}`;
const mapText = (g: GameSummary) => `${g.map.name} (Revision ${String(g.map.revision)})`;
const localTime = (iso: string) => new Date(iso).toLocaleString();

function resultText(result: GameResult): string {
  const how = `${END_TEXT[result.end]}, Tick ${String(result.tick)}`;
  return result.winner === null
    ? `Draw (${how})`
    : `${result.winner.username} wins ${result.decidedBy === null ? "" : `${DECIDED_TEXT[result.decidedBy]} `}(${how})`;
}

/** Where a Game stands, in a few words. */
function outcomeText(g: GameSummary): string {
  switch (g.state) {
    case "open":
      return `fills by ${localTime(g.fillDeadline)}`;
    case "running":
      return `running since ${ago(g.startedAt)}`;
    case "finished":
      return g.result === null ? "finished" : resultText(g.result);
    case "cancelled":
      return `cancelled (${g.cancelReason ?? "unknown"})`;
  }
}

function gameLines(g: Game): string[] {
  const rows = [
    ["id:", g.id],
    ["state:", g.state],
    ["initiator:", g.initiator.username],
    ["Ruleset:", g.rulesetVersion],
    ["Map:", `${mapText(g)}, ${g.map.id}`],
    ["Entries:", `${entriesText(g)} Players`],
    ["Point Budget:", String(g.pointBudget)],
    ["time limit:", `${String(g.timeLimitSeconds)} s, ${PACE_TEXT[g.pace]}`],
    ["created:", ago(g.createdAt)],
    ...(g.state === "open" ? [["fill deadline:", localTime(g.fillDeadline)]] : []),
    ...(g.startedAt === null ? [] : [["started:", ago(g.startedAt)]]),
    ...(g.endedAt === null ? [] : [["ended:", ago(g.endedAt)]]),
    ...(g.cancelReason === null ? [] : [["cancelled:", g.cancelReason]]),
    ...(g.result === null ? [] : [["result:", resultText(g.result)]]),
  ];
  const bot = (b: Game["entries"][number]["bots"][number]) =>
    b.design === undefined ? b.name : `${b.name} (${b.design.designId}@${String(b.design.revision)})`;
  return [
    ...table(rows, ""),
    ...(g.entries.length === 0
      ? []
      : [
          "",
          ...table(
            [
              ["Entry", "Player", "Cost", "Bots"],
              ...g.entries.map((e) => [e.id, e.player.username, e.cost === undefined ? "-" : String(e.cost), e.bots.map(bot).join(", ")]),
            ],
            "",
          ),
        ]),
  ];
}

/** `--bot NAME=DESIGN_ID[@REV]`: split at the first `=` and the last `@`. */
export function parseBot(text: string): Schema<"NewGameEntryBot"> {
  const eq = text.indexOf("=");
  const name = text.slice(0, eq);
  const design = text.slice(eq + 1);
  const at = design.lastIndexOf("@");
  const designId = at < 0 ? design : design.slice(0, at);
  if (eq <= 0 || designId === "") throw usageError(`--bot needs NAME=DESIGN_ID[@REV], got "${text}"`);
  return { name, designId, ...(at < 0 ? {} : { revision: wholeNumber(`--bot ${name}'s Revision`, design.slice(at + 1)) }) };
}

/** Player usernames by id, for Replays, which name Players by id. */
function usernames(game: Game): Map<string, string> {
  return new Map([[game.initiator.id, game.initiator.username], ...game.entries.map((e) => [e.player.id, e.player.username] as const)]);
}

/** The Replay's result, as `aumohta run` prints it, with Players by username. */
function replayResultLines(replay: Replay, game: Game): string[] {
  const { result } = replay;
  if (result === null) return game.result === null ? [] : [`Result: ${resultText(game.result)}`];
  const names = usernames(game);
  const name = (id: string) => names.get(id) ?? id;
  const engineResult: EngineResult = {
    tick: result.tick,
    end: result.end,
    winner: result.winner === null ? null : name(result.winner),
    decidedBy: result.decidedBy,
    standings: result.standings.map((s) => ({ ...s, player: name(s.player) })),
  };
  return formatResult(engineResult, replay.tickRate);
}

/** Bot Names by Bot id, from a Replay's header. */
const botNames = (replay: Replay) => new Map(replay.entries.flatMap((e) => e.bots.map((b) => [b.id, b.name] as const)));

/** `Tick 12: Hunter Disabled (ram)`, as `aumohta run` announces it. */
function disabledLines(frame: ReplayTick, names: ReadonlyMap<number, string>): string[] {
  return (frame.events as readonly { type: string; tick: number; bot?: number; cause?: string }[]).flatMap((e) =>
    e.type === "disabled" && e.bot !== undefined ? [`Tick ${String(e.tick)}: ${names.get(e.bot) ?? `#${String(e.bot)}`} Disabled (${e.cause ?? ""})`] : [],
  );
}

function gamesTable(games: readonly GameSummary[], header: readonly string[], row: (g: GameSummary) => string[]): string[] {
  return games.length === 0 ? ["No Games."] : table([header, ...games.map(row)], "");
}

export const gamesCommands: Group = {
  create: {
    synopsis:
      "--map MAP_ID [--map-revision N] [--ruleset VERSION] [--players N] [--point-budget N] [--time-limit SECONDS] [--unthrottled] [--fill-timeout SECONDS]",
    summary: "Create an Open Game, with defaults as 'aumohta run' (POST /games)",
    options: {
      map: { type: "string" },
      "map-revision": { type: "string" },
      ruleset: { type: "string" },
      players: { type: "string" },
      "point-budget": { type: "string" },
      "time-limit": { type: "string" },
      unthrottled: { type: "boolean" },
      "fill-timeout": { type: "string" },
    },
    run: async (context, _args, values) => {
      const mapId = str(values, "map");
      if (mapId === undefined) throw usageError("--map is required");
      const mapRevision = optionalNumber(values, "map-revision");
      const playerCount = optionalNumber(values, "players", 2) ?? DEFAULT_PLAYERS;
      const timeLimitSeconds = optionalNumber(values, "time-limit") ?? DEFAULT_TIME_LIMIT_SECONDS;
      const fillTimeoutSeconds = optionalNumber(values, "fill-timeout") ?? DEFAULT_FILL_TIMEOUT_SECONDS;
      let pointBudget = optionalNumber(values, "point-budget");
      needKey(context);
      const rulesetVersion = await rulesetOrLatest(context, str(values, "ruleset"));
      pointBudget ??= (await context.client.request<Schema<"RulesetSummary">>("GET", `/rulesets/${segment(rulesetVersion)}`)).pointBudget.max;
      const body: Schema<"NewGame"> = {
        rulesetVersion,
        mapId,
        ...(mapRevision === undefined ? {} : { mapRevision }),
        playerCount,
        pointBudget,
        timeLimitSeconds,
        pace: flag(values, "unthrottled") ? "unthrottled" : "realtime",
        fillTimeoutSeconds,
      };
      const game = await context.client.request<Game>("POST", "/games", { auth: true, body });
      emit(context, game, () => [
        `Created Game ${game.id} on ${mapText(game)}: ${String(game.playerCount)} Players, Point Budget ${String(game.pointBudget)}, ${String(game.timeLimitSeconds)} s, ${PACE_TEXT[game.pace]}; fills by ${localTime(game.fillDeadline)}.`,
        `Enter it with 'aumohta games enter ${game.id} --bot NAME=DESIGN_ID'.`,
      ]);
    },
  },

  browse: {
    synopsis: "[--ruleset VERSION] [--map MAP_ID] [--players N] [--min-budget N] [--max-budget N] [--limit N] [--cursor CURSOR] [--all]",
    summary: "List Open Games, which take Entries (GET /games)",
    options: {
      ruleset: { type: "string" },
      map: { type: "string" },
      players: { type: "string" },
      "min-budget": { type: "string" },
      "max-budget": { type: "string" },
      ...PAGE_OPTIONS,
    },
    run: async (context, _args, values) => {
      const query = {
        rulesetVersion: str(values, "ruleset"),
        mapId: str(values, "map"),
        playerCount: optionalNumber(values, "players", 2),
        minPointBudget: optionalNumber(values, "min-budget", 0),
        maxPointBudget: optionalNumber(values, "max-budget", 0),
      };
      const list = await fetchList<"games", GameSummary>(context.client, "/games", "games", pageOptions(values), { auth: true, query });
      emit(context, list, () =>
        gamesTable(list.games, ["ID", "Ruleset", "Map", "Entries", "Point Budget", "Time limit", "Initiator", "Fills by"], (g) => [
          g.id,
          g.rulesetVersion,
          mapText(g),
          entriesText(g),
          String(g.pointBudget),
          `${String(g.timeLimitSeconds)} s, ${PACE_TEXT[g.pace]}`,
          g.initiator.username,
          localTime(g.fillDeadline),
        ]),
      );
      moreHint(context, list.nextCursor);
    },
  },

  mine: {
    synopsis: "[--state open,running,finished,cancelled] [--limit N] [--cursor CURSOR] [--all]",
    summary: "List the Games you created or entered, newest first (GET /players/me/games)",
    options: { state: { type: "string" }, ...PAGE_OPTIONS },
    run: async (context, _args, values) => {
      const query = { state: str(values, "state") };
      const list = await fetchList<"games", GameSummary>(context.client, "/players/me/games", "games", pageOptions(values), { auth: true, query });
      emit(context, list, () =>
        gamesTable(list.games, ["ID", "State", "Ruleset", "Map", "Entries", "Created", "Outcome"], (g) => [
          g.id,
          g.state,
          g.rulesetVersion,
          mapText(g),
          entriesText(g),
          ago(g.createdAt),
          outcomeText(g),
        ]),
      );
      moreHint(context, list.nextCursor);
    },
  },

  show: {
    synopsis: "GAME_ID",
    summary: "Show a Game and its Entries (GET /games/{gameId})",
    args: ["GAME_ID"],
    run: async (context, [id = ""]) => {
      const game = await context.client.request<Game>("GET", gamePath(id), { auth: true });
      emit(context, game, () => gameLines(game));
    },
  },

  cancel: {
    synopsis: "GAME_ID",
    summary: "Cancel an Open Game you created (POST /games/{gameId}/cancel)",
    args: ["GAME_ID"],
    run: async (context, [id = ""]) => {
      const game = await context.client.request<Game>("POST", `${gamePath(id)}/cancel`, { auth: true });
      emit(context, game, () => [`Cancelled Game ${game.id}.`]);
    },
  },

  enter: {
    synopsis: "GAME_ID --bot NAME=DESIGN_ID[@REV] [--bot ...] | --entry-json FILE",
    summary: "Enter an Open Game, one --bot per Bot (POST /games/{gameId}/entries)",
    args: ["GAME_ID"],
    options: { bot: { type: "string", multiple: true }, "entry-json": { type: "string" } },
    run: async (context, [id = ""], values) => {
      const bots = strs(values, "bot");
      const file = str(values, "entry-json");
      if ((bots.length > 0) === (file !== undefined)) throw usageError("give --bot NAME=DESIGN_ID[@REV] (one per Bot) or --entry-json FILE");
      const body = file === undefined ? { bots: bots.map(parseBot) } : await readJsonInput(context, file, "--entry-json");
      const { entry, game } = await context.client.request<Schema<"SubmittedGameEntry">>("POST", `${gamePath(id)}/entries`, { auth: true, body });
      emit(context, { entry, game }, () => [
        `Entered Game ${game.id} with Entry ${entry.id}: ${entry.bots.map((b) => b.name).join(", ")}${entry.cost === undefined ? "" : `, ${String(entry.cost)} points`}.`,
        game.state === "open"
          ? `Waiting for ${String(game.playerCount - game.entryCount)} more of ${String(game.playerCount)} Entries.`
          : `The Game is full and ${game.state}; watch it with 'aumohta games watch ${game.id}'.`,
      ]);
    },
  },

  withdraw: {
    synopsis: "GAME_ID ENTRY_ID",
    summary: "Withdraw your Entry from an Open Game (DELETE /games/{gameId}/entries/{entryId})",
    args: ["GAME_ID", "ENTRY_ID"],
    run: async (context, [id = "", entryId = ""]) => {
      await context.client.request("DELETE", `${gamePath(id)}/entries/${segment(entryId)}`, { auth: true });
      emit(context, {}, () => [`Withdrew Entry ${entryId} from Game ${id}.`]);
    },
  },

  snapshot: {
    synopsis: "GAME_ID",
    summary: "Show the latest Tick of a Running or Finished Game (GET /games/{gameId}/snapshot)",
    args: ["GAME_ID"],
    run: async (context, [id = ""]) => {
      const snapshot = await context.client.request<GameSnapshot>("GET", `${gamePath(id)}/snapshot`, { auth: true });
      emit(context, snapshot, () => snapshotLines(snapshot));
    },
  },

  watch: {
    synopsis: "GAME_ID [--out FILE] [--wait]",
    summary: "Follow a Game live until it ends (GET /games/{gameId}/stream); --out writes the Replay assembled from the stream",
    args: ["GAME_ID"],
    options: { out: { type: "string" }, wait: { type: "boolean" } },
    run: (context, [id = ""], values) => watch(context, id, values),
  },

  replay: {
    synopsis: "GAME_ID [--out FILE]",
    summary: "Get a Finished Game's Replay (GET /games/{gameId}/replay); --out writes it as 'aumohta run' writes replay.json",
    args: ["GAME_ID"],
    options: { out: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const body = await context.client.request<Schema<"GameReplay">>("GET", `${gamePath(id)}/replay`, { auth: true });
      const out = str(values, "out");
      if (out !== undefined) await writeOutput(out, `${JSON.stringify(body.replay)}\n`);
      emit(context, body, () =>
        out === undefined ? [JSON.stringify(body.replay)] : [`Wrote the Replay of Game ${body.game.id} (${String(body.replay.ticks.length)} Ticks) to ${out}.`],
      );
    },
  },

  logs: {
    synopsis: "GAME_ID [--from-tick N] [--to-tick N] [--out FILE]",
    summary: "Get your Bots' Program logs in a Game (GET /games/{gameId}/program-logs); --out writes them as 'aumohta run' writes program-logs.json",
    args: ["GAME_ID"],
    options: { "from-tick": { type: "string" }, "to-tick": { type: "string" }, out: { type: "string" } },
    run: async (context, [id = ""], values) => {
      const fromTick = optionalNumber(values, "from-tick", 0);
      const toTick = optionalNumber(values, "to-tick", 0);
      if (fromTick !== undefined && toTick !== undefined && toTick < fromTick) throw usageError("--to-tick must not be before --from-tick");
      const logs = await context.client.request<Schema<"ProgramLogs">>("GET", `${gamePath(id)}/program-logs`, { auth: true, query: { fromTick, toTick } });
      const out = str(values, "out");
      if (out !== undefined) await writeOutput(out, `${JSON.stringify(logs)}\n`);
      emit(context, logs, () => {
        if (out === undefined) return [JSON.stringify(logs)];
        const runs = logs.bots.reduce((n, b) => n + b.runs.length, 0);
        return [`Wrote ${String(runs)} Program runs of ${String(logs.bots.length)} Bots in Game ${id} to ${out}.`];
      });
    },
  },
};

function snapshotLines({ game, replay }: GameSnapshot): string[] {
  const frame = replay.ticks[replay.ticks.length - 1];
  const names = botNames(replay);
  const owners = usernames(game);
  const ownerOf = new Map(replay.entries.flatMap((e) => e.bots.map((b) => [b.id, owners.get(e.player) ?? e.player] as const)));
  const num = (v: number) => String(Math.round(v * 10) / 10);
  return [
    `Game ${game.id} (${game.state}), Ruleset ${replay.ruleset}, ${mapText(game)}`,
    ...(frame === undefined
      ? []
      : [
          `Tick ${String(frame.tick)} of ${String(replay.timeLimitTicks)} (${num(frame.tick / replay.tickRate)} s of ${num(replay.timeLimitTicks / replay.tickRate)} s)`,
          ...table([
            ["Bot", "Name", "Player", "Hit Points", "Status", "Position", "Heading", "Speed"],
            ...frame.bots.map((b) => [
              String(b.id),
              names.get(b.id) ?? "",
              ownerOf.get(b.id) ?? "",
              num(b.hitPoints),
              b.status,
              `${num(b.x)}, ${num(b.y)}`,
              `${num(b.heading)}°`,
              `${num(b.speed)} m/s`,
            ]),
          ]),
        ]),
    ...(replay.result === null ? [] : ["", ...replayResultLines(replay, game)]),
  ];
}

/** What `games watch` has seen so far. */
interface Watching {
  game?: Game;
  /** The Replay assembled from the stream: the first snapshot's header (kept current) and every Tick since. */
  replay?: Replay;
  names: Map<number, string>;
  lastTick: number;
  /** The last event id, sent as `Last-Event-ID` on reconnect. */
  lastEventId?: string;
}

/**
 * `games watch`: follows the stream until `end`. When it closes early it
 * reconnects for a fresh snapshot, up to RECONNECT_BACKOFF_MS.length times in
 * a row, the count resetting whenever an event arrives.
 */
async function watch(context: Context, id: string, values: Values): Promise<void> {
  needKey(context);
  const out = str(values, "out");
  const sleep = sleeper(context);
  const watching: Watching = { names: new Map(), lastTick: -1 };
  let connected = false;
  let attempt = 0;
  for (;;) {
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      body = await context.client.openStream(`${gamePath(id)}/stream`, watching.lastEventId);
      connected = true;
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (e.code === "game_not_started" && flag(values, "wait") && !connected) {
        await waitForStart(context, id, sleep);
        continue;
      }
      // Once watching, a server that is briefly away (restarting) is a closed stream; before that, a failure.
      if (!connected || e.exitCode !== EXIT.server) throw e;
    }
    if (body !== undefined) {
      const events = readEvents(body);
      for (;;) {
        let next: IteratorResult<StreamEvent>;
        try {
          next = await events.next();
        } catch {
          break; // The connection dropped: reconnect, as for a closed stream.
        }
        if (next.done === true) break;
        attempt = 0;
        if (onEvent(context, watching, next.value)) {
          await finishWatch(context, id, watching, out);
          return;
        }
      }
    }
    const delay = RECONNECT_BACKOFF_MS[attempt];
    if (delay === undefined) {
      throw new CliError(EXIT.server, "network", `the stream of Game ${id} closed ${String(attempt + 1)} times in a row before the Game ended`);
    }
    attempt++;
    if (context.json) context.io.out(JSON.stringify({ event: "reconnect", attempt }));
    else context.io.err(`The stream closed; reconnecting in ${String(delay / 1000)} s (attempt ${String(attempt)} of ${String(RECONNECT_BACKOFF_MS.length)}).`);
    await sleep(delay);
  }
}

/** `--wait`: polls the Game until it is no longer Open. */
async function waitForStart(context: Context, id: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let first = true; ; first = false) {
    const game = await context.client.request<Game>("GET", gamePath(id), { auth: true });
    if (game.state !== "open") return;
    if (first && !context.json) {
      context.io.err(`Waiting for Game ${id} to fill (${entriesText(game)} Entries); checking every ${String(WAIT_POLL_MS / 1000)} s.`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** Handles one stream event; true once the Game has ended. */
function onEvent(context: Context, watching: Watching, event: StreamEvent): boolean {
  const data = parseJson(event.data, `the stream's ${event.event} event`);
  if (event.id !== undefined) watching.lastEventId = event.id;
  if (context.json) context.io.out(JSON.stringify({ event: event.event, id: event.id ?? null, data }));
  switch (event.event) {
    case "snapshot": {
      const { game, replay } = data as GameSnapshot;
      watching.game = game;
      if (watching.replay === undefined) {
        watching.names = botNames(replay);
        if (!context.json) {
          const players = game.entries.map((e) => `${e.player.username} (${e.bots.map((b) => b.name).join(", ")})`).join(" vs ");
          context.io.out(`Watching Game ${game.id}: Ruleset ${replay.ruleset}, ${mapText(game)}, ${players}`);
          context.io.out(`Time limit ${String(replay.timeLimitTicks / replay.tickRate)} s (${String(replay.timeLimitTicks)} Ticks), ${PACE_TEXT[game.pace]}`);
        }
      }
      watching.replay = { ...replay, ticks: watching.replay?.ticks ?? [] };
      for (const frame of replay.ticks) addTick(context, watching, frame);
      return false;
    }
    case "tick":
      addTick(context, watching, data as ReplayTick);
      return false;
    case "end":
      watching.game = (data as Schema<"GameEnded">).game;
      return true;
    default:
      return false;
  }
}

function addTick(context: Context, watching: Watching, frame: ReplayTick): void {
  if (watching.replay === undefined || frame.tick <= watching.lastTick) return;
  if (!context.json && watching.lastTick >= 0 && frame.tick > watching.lastTick + 1) {
    const missed = `${String(watching.lastTick + 1)}${frame.tick - 1 > watching.lastTick + 1 ? ` to ${String(frame.tick - 1)}` : ""}`;
    context.io.err(`Missed Tick ${missed} while reconnecting; the Replay assembled lacks it.`);
  }
  watching.replay.ticks.push(frame);
  watching.lastTick = frame.tick;
  if (!context.json) for (const line of disabledLines(frame, watching.names)) context.io.out(line);
}

/** After `end`: completes the Replay's result from the final snapshot if need be, writes `--out` and prints the result. */
async function finishWatch(context: Context, id: string, watching: Watching, out: string | undefined): Promise<void> {
  if ((out !== undefined || !context.json) && watching.replay?.result == null) {
    const last = await context.client.request<GameSnapshot>("GET", `${gamePath(id)}/snapshot`, { auth: true });
    watching.replay = { ...last.replay, ticks: watching.replay?.ticks ?? [] };
    for (const frame of last.replay.ticks) addTick(context, watching, frame);
  }
  if (out !== undefined && watching.replay !== undefined) await writeOutput(out, `${JSON.stringify(watching.replay)}\n`);
  const { game, replay } = watching;
  if (context.json || game === undefined || replay === undefined) return;
  context.io.out("");
  for (const line of replayResultLines(replay, game)) context.io.out(line);
  if (out !== undefined) context.io.out(`Replay: ${out}`);
}

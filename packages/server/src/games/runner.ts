/**
 * The Game runner: plays Running Games in-process (spec sections 1, 7 and 8;
 * ADR-0003).
 *
 * A Game becomes Running in the transaction of the Entry that fills it; the
 * runner is then told to `pickUp` every Running Game it is not yet playing,
 * and does the same at startup. To start a Game it draws a seed, has the
 * Ruleset version's engine create it (running every init phase), and stores
 * the Game Record in object storage before the first Tick. It then plays at
 * the Game's Pace: realtime keeps one simulated second per real second;
 * unthrottled plays as fast as it can in short slices, letting requests and
 * other Games run in between. At most `maxConcurrentUnthrottledGames`
 * unthrottled Games play at once; the others wait, in the order they
 * started, for a slot (with a limit of 0 they wait until a restart with a
 * higher one). Realtime Games are not limited.
 *
 * Progress is saved as the last Tick played (after every Tick in realtime,
 * after every slice unthrottled). When a Game ends, the final Game Record,
 * the Replay and each Player's Program logs are stored, then the Game is
 * Finished with its result.
 *
 * Spectating: while a Game is being played its Replay so far and Program
 * logs can be read from here, and watchers (the SSE stream) hear of it
 * starting, of every Tick as it is played, and of it Finishing, or of the
 * runner stopping without Finishing it (see `watch`).
 *
 * Resuming: the simulation is deterministic (ADR-0001), so after a restart
 * or crash a Running Game is resumed by replaying its stored Game Record up
 * to the last Tick saved, at once, and playing on from there; it reaches
 * the same outcome as if it had never stopped. Every step can be repeated:
 * a Game with no stored Game Record yet has played no Tick and simply
 * starts afresh, and a Game that ended but was not yet marked Finished is
 * replayed to its end and finished again with the same result.
 *
 * A Game that fails (its engine throws, or storage does) is logged and left
 * Running; it is retried when the server next starts.
 */

import { randomInt } from "node:crypto";
import type { Logger } from "../app.js";
import type { GameRecord } from "../db/games.js";
import type { Services } from "../http/router.js";
import type { EngineGame, GameStart, ProgramLogData, ReplayData, ReplayFrame } from "./engine.js";

/** Where a Game's Game Record is stored: once before its first Tick, again when it ends. */
export const gameRecordKey = (gameId: string): string => `games/${gameId}/record.json`;

/** Where a Finished Game's Replay is stored. */
export const replayKey = (gameId: string): string => `games/${gameId}/replay.json`;

/** Where a Finished Game's Program logs for one Player's Bots are stored. */
export const programLogsKey = (gameId: string, playerId: string): string => `games/${gameId}/program-logs/${playerId}.json`;

/** What a watcher of a Running Game hears, in this order. */
export type GameFeedEvent =
  /** Playing has started (or resumed), or it already had when the watcher was added: the Replay so far. */
  | { readonly kind: "started"; readonly replay: ReplayData }
  /** One Tick more has been played. */
  | { readonly kind: "tick"; readonly frame: ReplayFrame }
  /** The Game is Finished, and its result saved. The last event. */
  | { readonly kind: "finished" }
  /** The runner stopped playing the Game without Finishing it (shutdown, or the Game failed). The last event. */
  | { readonly kind: "stopped" };

export type GameWatcher = (event: GameFeedEvent) => void;

/** How long an unthrottled Game plays before saving its progress and letting other work run. */
export const UNTHROTTLED_SLICE_MS = 50;

/** The largest Game seed, plus one. */
const SEED_LIMIT = 2 ** 32;

/** How realtime Pace is kept; injectable so tests need not wait. */
export interface Pacing {
  /** Waits `ms` real milliseconds; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
}

export interface RunnerOptions extends Pacing {
  readonly logger: Logger;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export class GameRunner {
  readonly #services: Omit<Services, "runner">;
  readonly #logger: Logger;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** The Games being played (or started), by id. */
  readonly #playing = new Map<string, Promise<void>>();
  /** Unthrottled Games waiting for a slot, in the order they were picked up. */
  #waiting: string[] = [];
  /** Unthrottled Games holding a slot. */
  #unthrottled = 0;
  /** The Games being played that have started (or resumed), by id. */
  readonly #live = new Map<string, EngineGame>();
  /** Who is watching each Game, by id; a Game may be watched before it starts. */
  readonly #watchers = new Map<string, Set<GameWatcher>>();
  /** Games that failed in this process; not retried until a restart. */
  readonly #failed = new Set<string>();
  #stopping = false;
  readonly #stopped: Promise<void>;
  #stop: () => void = () => undefined;

  constructor(services: Omit<Services, "runner">, options: RunnerOptions) {
    this.#services = services;
    this.#logger = options.logger;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => performance.now());
    this.#stopped = new Promise((resolve) => {
      this.#stop = resolve;
    });
  }

  /** Starts (or resumes) every Running Game not already being played or waiting. */
  pickUp(): void {
    if (this.#stopping) return;
    for (const game of this.#services.db.games.listRunningGames()) {
      const { id } = game;
      if (this.#playing.has(id) || this.#waiting.includes(id) || this.#failed.has(id)) continue;
      if (game.pace === "unthrottled") this.#waiting.push(id);
      else this.#launch(id);
    }
    this.#admit();
  }

  /** Resolves once no Game is being played; Games waiting for a slot do not count. For tests. */
  async idle(): Promise<void> {
    while (this.#playing.size > 0) await Promise.all(this.#playing.values());
  }

  /**
   * Stops playing: every Game stops after its current Tick or slice and
   * stays Running, with its progress saved, to be resumed at the next
   * startup. Resolves once all have stopped.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#waiting = [];
    this.#stop();
    for (const id of [...this.#watchers.keys()]) this.#end(id, { kind: "stopped" });
    await this.idle();
  }

  /**
   * Watches a Running Game: `watcher` hears `started` (at once if the Game
   * is already being played), then every Tick, then `finished` or
   * `stopped`. A Game that is not Running, or that this runner will not
   * play (it failed, or the runner is stopping), is `stopped` at once.
   * Returns a function that stops watching.
   */
  watch(id: string, watcher: GameWatcher): () => void {
    // A Game is marked Finished in the same synchronous step that tells its watchers, so this check is exact.
    const running = this.#services.db.games.getGame(id)?.state === "running";
    if (!running || this.#stopping || this.#failed.has(id)) {
      watcher({ kind: "stopped" });
      return () => undefined;
    }
    let watchers = this.#watchers.get(id);
    if (watchers === undefined) {
      watchers = new Set();
      this.#watchers.set(id, watchers);
    }
    watchers.add(watcher);
    const game = this.#live.get(id);
    if (game !== undefined) this.#tell(id, watcher, { kind: "started", replay: game.replay() });
    const set = watchers;
    return () => {
      set.delete(watcher);
      if (set.size === 0 && this.#watchers.get(id) === set) this.#watchers.delete(id);
    };
  }

  /** The Replay so far of a Game being played, or undefined if it has not started (or resumed) here. */
  replay(id: string): ReplayData | undefined {
    return this.#live.get(id)?.replay();
  }

  /** The Program logs of `player`'s Bots in a Game being played, or undefined if it has not started here. */
  programLogs(id: string, player: string): readonly ProgramLogData[] | undefined {
    return this.#live.get(id)?.programLogs(player);
  }

  /** Tells one watcher; a watcher that throws is logged, and never stops the Game. */
  #tell(id: string, watcher: GameWatcher, event: GameFeedEvent): void {
    try {
      watcher(event);
    } catch (error) {
      this.#logger.error("Game watcher failed", {
        game: id,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  /** Tells everyone watching Game `id`; `event` is made only if someone is. */
  #notify(id: string, event: () => GameFeedEvent): void {
    const watchers = this.#watchers.get(id);
    if (watchers === undefined || watchers.size === 0) return;
    const told = event();
    // A watcher may stop watching while being told.
    for (const watcher of [...watchers]) this.#tell(id, watcher, told);
  }

  /** Tells everyone watching Game `id` the last event, and forgets them. */
  #end(id: string, event: GameFeedEvent): void {
    this.#notify(id, () => event);
    this.#watchers.delete(id);
  }

  /** Gives free unthrottled slots to waiting Games. */
  #admit(): void {
    const limit = this.#services.config.limits.maxConcurrentUnthrottledGames;
    while (!this.#stopping && this.#unthrottled < limit) {
      const id = this.#waiting.shift();
      if (id === undefined) return;
      this.#unthrottled++;
      this.#launch(id, () => {
        this.#unthrottled--;
        this.#admit();
      });
    }
  }

  #launch(id: string, release?: () => void): void {
    const play = this.#play(id)
      .catch((error: unknown) => {
        this.#failed.add(id);
        this.#logger.error("Game failed; it stays Running until the server restarts", {
          game: id,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      })
      .finally(() => {
        this.#playing.delete(id);
        this.#live.delete(id);
        // A Game that Finished has told its watchers already; any others hear it stopped.
        this.#end(id, { kind: "stopped" });
        release?.();
      });
    this.#playing.set(id, play);
  }

  async #play(id: string): Promise<void> {
    const { db, rulesets, objects, clock } = this.#services;
    const game = db.games.getGame(id);
    if (game?.state !== "running") return;
    const hosted = rulesets.get(game.rulesetVersion);
    if (hosted === undefined) {
      throw new Error(`Game ${id} uses Ruleset ${game.rulesetVersion}, which this server does not host`);
    }

    let played: EngineGame;
    const stored = await objects.get(gameRecordKey(id));
    if (stored === undefined) {
      played = hosted.engine.start(this.#gameStart(game, hosted.ruleset.tickRate));
      await objects.put(gameRecordKey(id), encode(played.record()));
    } else {
      played = hosted.engine.resume(JSON.parse(new TextDecoder().decode(stored)) as unknown, game.lastTick ?? 0);
    }
    db.games.saveProgress(id, played.tick());
    this.#live.set(id, played);
    this.#notify(id, () => ({ kind: "started", replay: played.replay() }));
    const ticked = () => {
      this.#notify(id, () => ({ kind: "tick", frame: played.frame() }));
    };

    const tickMs = 1000 / hosted.ruleset.tickRate;
    const fromTick = played.tick();
    const startedAt = this.#now();
    let outcome = played.outcome();
    while (outcome === null) {
      if (this.#stopping) return;
      if (game.pace === "realtime") {
        played.playTick();
        ticked();
        db.games.saveProgress(id, played.tick());
        outcome = played.outcome();
        if (outcome === null) {
          const wait = startedAt + (played.tick() - fromTick) * tickMs - this.#now();
          await Promise.race([this.#sleep(Math.max(0, wait)), this.#stopped]);
        }
      } else {
        const until = this.#now() + UNTHROTTLED_SLICE_MS;
        do {
          played.playTick();
          ticked();
          outcome = played.outcome();
        } while (outcome === null && this.#now() < until);
        db.games.saveProgress(id, played.tick());
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    await objects.put(gameRecordKey(id), encode(played.record()));
    await objects.put(replayKey(id), encode(played.replay()));
    for (const player of new Set(db.games.listEntries(id).map((entry) => entry.player.id))) {
      await objects.put(programLogsKey(id, player), encode(played.programLogs(player)));
    }
    db.games.finishGame(
      id,
      { tick: outcome.tick, end: outcome.end, winnerId: outcome.winner, decidedBy: outcome.decidedBy },
      clock(),
    );
    this.#end(id, { kind: "finished" });
  }

  /** What a Game starts from: its Map Revision, and its Entries with their Builds and Programs. */
  #gameStart(game: GameRecord, tickRate: number): GameStart {
    const { db } = this.#services;
    const map = db.maps.getRevision(game.map.id, game.map.revision);
    if (map === undefined) throw new Error(`Game ${game.id} references a missing Map Revision`);
    const programs = db.games.listPrograms(game.id);
    return {
      map: map.map,
      entries: db.games.listEntries(game.id).map((entry) => ({
        player: entry.player.id,
        bots: entry.bots.map((bot, i) => {
          const program = programs.get(entry.id)?.[i];
          if (program === undefined) throw new Error(`Bot "${bot.name}" of Game ${game.id} has no Program`);
          return { name: bot.name, build: bot.build, program };
        }),
      })),
      seed: randomInt(0, SEED_LIMIT),
      timeLimitTicks: game.timeLimitSeconds * tickRate,
    };
  }
}

/**
 * What the Game runner needs from a Ruleset version's frozen engine.
 *
 * Each engine has its own Game, Game Record and Replay types; the runner
 * sees them only through this interface, so hosting another version means
 * writing one more adapter like `r1Engine` below and wiring it up in
 * rulesets/catalog.ts. Game Records, Replays and Program logs leave here as
 * plain JSON data, and a Game Record comes back the same way to resume a
 * Game. The server relies on only a little of their shape: a Replay is a
 * header plus one frame per Tick (`ReplayData`), and a Program log is one
 * entry per run (`ProgramLogData`); the rest is the engine's own.
 */

import {
  createGame,
  earlierTicks,
  gameRecord,
  playTick,
  programLogs,
  replayGame,
  replayOf,
  type Game,
  type GameRecord,
  type GameResult,
  type ReplayTick,
} from "@positrontanks/engine-r1";
import type { Build, MapFormat1, Ruleset } from "@positrontanks/ruleset-data";
import type { DecidedBy, GameEnd } from "../db/games.js";

/** Everything a Game is started from; it all goes into the Game Record. */
export interface GameStart {
  readonly map: MapFormat1;
  /** In Entry order. */
  readonly entries: readonly {
    /** The Player's id; a Player with several Entries is still one Player. */
    readonly player: string;
    readonly bots: readonly { readonly name: string; readonly build: Build; readonly program: string }[];
  }[];
  /** An integer in [0, 2^32). */
  readonly seed: number;
  readonly timeLimitTicks: number;
}

/** How a Game ended, in the server's terms. */
export interface GameOutcome {
  /** The Tick the Game ended in; 0 if it ended in the init phase. */
  readonly tick: number;
  readonly end: GameEnd;
  /** The winning Player's id, or null for a Draw. */
  readonly winner: string | null;
  readonly decidedBy: DecidedBy | null;
}

/** One Tick of a Replay: what happened in it and the world at its end (the init phase is Tick 0). */
export interface ReplayFrame {
  readonly tick: number;
}

/** A Replay: a header (Builds, Map, ...; never Programs) and every Tick played so far, from the init phase. */
export interface ReplayData {
  readonly ticks: readonly ReplayFrame[];
}

/** One Bot's Program log, which only the Bot's owner may see. */
export interface ProgramLogData {
  /** The Bot's id in the Replay. */
  readonly bot: number;
  readonly name: string;
  /** Every run of the Program, from the init phase (Tick 0), in Tick order. */
  readonly runs: readonly { readonly tick: number; readonly result: unknown }[];
}

/** A Game being played. */
export interface EngineGame {
  /** The last Tick played; 0 after the init phase. */
  tick(): number;
  /** Null until the Game has ended. */
  outcome(): GameOutcome | null;
  /** Plays one Tick; throws if the Game has ended. */
  playTick(): void;
  /** The Game Record as it stands. */
  record(): unknown;
  /** The Replay as it stands: events and Builds, never Programs. */
  replay(): ReplayData;
  /** The last Tick played (the init phase before the first): one of the Replay's frames. */
  frame(): ReplayFrame;
  /** The Program logs of `player`'s Bots, in Bot id order. */
  programLogs(player: string): readonly ProgramLogData[];
}

export interface GameEngine {
  /** Creates the Game and runs every init phase. Throws if the Game cannot start. */
  start(game: GameStart): EngineGame;
  /**
   * Plays a Game Record that `record()` produced again, up to the end of
   * Tick `toTick` or the end of the Game if that comes first. Throws if the
   * record does not reproduce.
   */
  resume(record: unknown, toTick: number): EngineGame;
  /**
   * What the Ticks of `replay` before its latest left behind (Obstacles
   * destroyed, damage dealt, Bots Disabled and so on, in the engine's own
   * terms), for a snapshot: a Spectator joining at the latest Tick sees the
   * Game as it stands. Its size must not grow with the number of Ticks.
   */
  earlierTicks(replay: ReplayData): unknown;
}

const R1_ENDS: Readonly<Record<GameResult["end"], GameEnd>> = {
  lastStanding: "last_standing",
  noneStanding: "none_standing",
  timeLimit: "time_limit",
};

const R1_DECIDED_BY: Readonly<Record<NonNullable<GameResult["decidedBy"]>, DecidedBy>> = {
  survival: "survival",
  foeDamage: "foe_damage",
  hitPoints: "hit_points",
};

function r1Game(game: Game): EngineGame {
  // Read through a function: playTick sets the result behind the type checker's back.
  const result = (): GameResult | null => game.result;
  return {
    tick: () => game.world.tick,
    outcome: () => {
      const r = result();
      if (r === null) return null;
      const decidedBy = r.decidedBy === null ? null : R1_DECIDED_BY[r.decidedBy];
      return { tick: r.tick, end: R1_ENDS[r.end], winner: r.winner, decidedBy };
    },
    playTick: () => {
      playTick(game);
    },
    record: () => gameRecord(game),
    replay: () => replayOf(game),
    frame: () => {
      const last = game.history.at(-1);
      if (last === undefined) throw new Error("a Game has its init phase in its history");
      return last;
    },
    programLogs: (player) => programLogs(game, player),
  };
}

/** engine-r1 playing Games under `ruleset` (r1, or a test variant of it). */
export function r1Engine(ruleset: Ruleset): GameEngine {
  return {
    start: (game) => r1Game(createGame({ ruleset, ...game })),
    resume: (record, toTick) => r1Game(replayGame(record as GameRecord, ruleset, toTick)),
    earlierTicks: (replay) => {
      const ticks = replay.ticks as readonly ReplayTick[];
      return earlierTicks(ticks, ticks.at(-1)?.tick ?? 0);
    },
  };
}

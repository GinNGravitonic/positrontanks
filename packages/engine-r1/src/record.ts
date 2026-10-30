/**
 * Game Records, Replays and Program logs (v1.md sections 2 and 8).
 *
 * A Game Record holds everything needed to play a Game again exactly,
 * Programs included, so only the server that played the Game holds it.
 * Replaying it reaches the same state at every Tick, which is how a server
 * resumes a Running Game after a restart. A Replay is what anyone may
 * rewatch: events and Builds, never Programs. Each Program log goes only to
 * the Bot's owner.
 */

import type { Build, MapFormat1, Ruleset } from "@positrontanks/ruleset-data";
import { createGame, playTick, type Game, type ProgramLog } from "./game.js";
import type { GameResult } from "./outcome.js";
import type { Replay } from "./replay.js";

export interface RecordedBot {
  readonly name: string;
  readonly build: Build;
  readonly program: string;
}

export interface RecordedEntry {
  readonly player: string;
  readonly bots: readonly RecordedBot[];
}

/** Where a Bot was placed at Game start. */
export interface StartingPosition {
  readonly bot: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export interface GameRecord {
  /** The Ruleset version. */
  readonly ruleset: string;
  readonly map: MapFormat1;
  /** In Entry order. */
  readonly entries: readonly RecordedEntry[];
  readonly seed: number;
  readonly timeLimitTicks: number;
  /** In Bot id order; replaying checks that every Bot starts here again. */
  readonly startingPositions: readonly StartingPosition[];
  /** The last Tick played when the record was made. */
  readonly tick: number;
  /** Operations each Program used, by Tick from the init phase (0); null where it did not run. In Bot id order. */
  readonly operations: readonly { readonly bot: number; readonly perTick: readonly (number | null)[] }[];
  /** Null while the Game is still Running. */
  readonly result: GameResult | null;
}

/** The Game Record of a Game as it stands. */
export function gameRecord(game: Game): GameRecord {
  const { setup, world, players } = game;
  const start = game.history[0];
  return {
    ruleset: setup.ruleset.version,
    map: setup.map,
    entries: setup.entries.map((e, i) => ({
      player: players[i] ?? "",
      bots: e.bots.map((b) => ({ name: b.name, build: b.build, program: b.program })),
    })),
    seed: setup.seed,
    timeLimitTicks: setup.timeLimitTicks,
    startingPositions: (start?.bots ?? []).map((b) => ({ bot: b.id, x: b.x, y: b.y, heading: b.heading })),
    tick: world.tick,
    operations: game.logs.map((log) => {
      const perTick: (number | null)[] = Array.from({ length: world.tick + 1 }, () => null);
      for (const run of log.runs) perTick[run.tick] = run.result.operations;
      return { bot: log.bot, perTick };
    }),
    result: game.result,
  };
}

/**
 * Plays the recorded Game again, under `ruleset`, up to the end of Tick
 * `toTick` (0 for just the init phase), or to the end of the Game if that
 * comes first. With no `toTick` it plays the Game to its end. The Game
 * returned can be played on from there with `playTick`. Throws if the
 * Ruleset is not the recorded version or a Bot does not start where the
 * record says.
 */
export function replayGame(record: GameRecord, ruleset: Ruleset, toTick = Infinity): Game {
  if (ruleset.version !== record.ruleset) {
    throw new Error(`the Game Record needs Ruleset ${record.ruleset}, not ${ruleset.version}`);
  }
  if (!(toTick >= 0)) throw new Error("the Tick to replay to must be 0 or more");
  const game = createGame({
    ruleset,
    map: record.map,
    entries: record.entries,
    seed: record.seed,
    timeLimitTicks: record.timeLimitTicks,
  });
  const { bots } = game.world;
  const same = (p: StartingPosition, i: number) => {
    const b = bots[i];
    return b !== undefined && b.id === p.bot && b.x === p.x && b.y === p.y && b.heading === p.heading;
  };
  if (record.startingPositions.length !== bots.length || !record.startingPositions.every(same)) throw new Error("the Bots do not start where the Game Record says");
  while (game.result === null && game.world.tick < toTick) playTick(game);
  return game;
}

/** The Replay of a Game as it stands: its events and Builds, never its Programs. */
export function replayOf(game: Game): Replay {
  const { setup, players } = game;
  let id = 0;
  return {
    ruleset: setup.ruleset.version,
    tickRate: setup.ruleset.tickRate,
    map: setup.map,
    timeLimitTicks: setup.timeLimitTicks,
    entries: setup.entries.map((e, i) => ({
      player: players[i] ?? "",
      bots: e.bots.map((b) => ({ id: ++id, name: b.name, build: b.build })),
    })),
    ticks: [...game.history],
    result: game.result,
  };
}

/** The Program logs of `player`'s Bots, in Bot id order. */
export function programLogs(game: Game, player: string): ProgramLog[] {
  return game.logs.filter((log) => log.player === player);
}

/**
 * The Replay: what anyone may rewatch once a Game is over (v1.md section 8).
 * It holds every participating Build and, for each Tick, its events and where
 * everything ended up, but never a Program or anything only a Program's owner
 * may see: Program logs are kept apart, per owner (record.ts).
 */

import type { Build, MapFormat1 } from "@aumohta/ruleset-data";
import type { TickEvent } from "./events.js";
import type { GameResult } from "./outcome.js";
import type { BotStatus, World } from "./world.js";

/** A Bot's visible state at the end of a Tick. */
export interface BotFrame {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly speed: number;
  readonly hitPoints: number;
  readonly status: BotStatus;
}

export interface ProjectileFrame {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** One Tick of a Replay: what happened in it, and the world at its end. */
export interface ReplayTick {
  /** 0 for the init phase, whose frame shows the starting positions. */
  readonly tick: number;
  readonly events: readonly TickEvent[];
  /** In Bot id order. */
  readonly bots: readonly BotFrame[];
  /** Projectiles in flight, in id order. */
  readonly projectiles: readonly ProjectileFrame[];
}

export interface ReplayBot {
  readonly id: number;
  readonly name: string;
  readonly build: Build;
}

export interface ReplayEntry {
  readonly player: string;
  /** In Bot id order. */
  readonly bots: readonly ReplayBot[];
}

export interface Replay {
  /** The Ruleset version. */
  readonly ruleset: string;
  readonly tickRate: number;
  readonly map: MapFormat1;
  readonly timeLimitTicks: number;
  /** In Entry order. */
  readonly entries: readonly ReplayEntry[];
  /** Every Tick played so far, from the init phase. */
  readonly ticks: readonly ReplayTick[];
  /** Null while the Game is still Running. */
  readonly result: GameResult | null;
}

/** The world's visible state, for a Replay. */
export function replayTick(world: World, events: readonly TickEvent[]): ReplayTick {
  return {
    tick: world.tick,
    events,
    bots: world.bots.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      heading: b.heading,
      speed: b.speed,
      hitPoints: b.hitPoints,
      status: b.status,
    })),
    projectiles: world.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y })),
  };
}

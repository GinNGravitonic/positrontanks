/**
 * The Replay: what anyone may rewatch once a Game is over (v1.md section 8).
 * It holds every participating Build and, for each Tick, its events and where
 * everything ended up, but never a Program or anything only a Program's owner
 * may see: Program logs are kept apart, per owner (record.ts).
 */

import type { Build, MapFormat1 } from "@positrontanks/ruleset-data";
import type { DisabledEvent, ObstacleDestroyedEvent, TickEvent } from "./events.js";
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

/**
 * Damage to one Bot summed over Ticks: Hit Points actually removed (`dealt`),
 * credited as the engine credits Foe damage: a shot to the Bot that fired it,
 * a ram to the other Bot, and anything else (a ram into a wreck, an Obstacle
 * or the boundary) to no Bot.
 */
export interface DamageTotal {
  /** The Bot that dealt it, or null when no Bot did. */
  readonly dealer: number | null;
  readonly target: number;
  readonly dealt: number;
}

/**
 * What the Ticks before some Tick left behind, for a Spectator who joins at
 * that Tick (v1.md section 8, Spectating): every Obstacle destroyed and Bot
 * Disabled, as their events, and the damage to Bots per (dealer, target)
 * pair. Its size is bounded by the Map and the Bots, however long the Game.
 */
export interface EarlierTicks {
  /** The Ticks summarized are those before this one. */
  readonly beforeTick: number;
  /** In the order they happened. */
  readonly obstaclesDestroyed: readonly ObstacleDestroyedEvent[];
  /** In the order they happened. */
  readonly disabled: readonly DisabledEvent[];
  /** Pairs with no Hit Points removed are left out; in the order each pair first took damage. */
  readonly damage: readonly DamageTotal[];
}

/** What `ticks` before Tick `beforeTick` left behind. */
export function earlierTicks(ticks: readonly ReplayTick[], beforeTick: number): EarlierTicks {
  const obstaclesDestroyed: ObstacleDestroyedEvent[] = [];
  const disabled: DisabledEvent[] = [];
  const damage = new Map<string, { dealer: number | null; target: number; dealt: number }>();
  for (const t of ticks) {
    if (t.tick >= beforeTick) continue;
    for (const e of t.events) {
      if (e.type === "obstacleDestroyed") obstaclesDestroyed.push(e);
      else if (e.type === "disabled") disabled.push(e);
      else if (e.type === "damage" && e.target.kind === "bot" && e.dealt > 0) {
        const dealer = e.source.kind === "weapon" ? e.source.bot : e.source.with.kind === "bot" ? e.source.with.id : null;
        const key = `${String(dealer)}>${String(e.target.id)}`;
        const total = damage.get(key);
        if (total === undefined) damage.set(key, { dealer, target: e.target.id, dealt: e.dealt });
        else total.dealt += e.dealt;
      }
    }
  }
  return { beforeTick, obstaclesDestroyed, disabled, damage: [...damage.values()] };
}

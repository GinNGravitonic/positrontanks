/**
 * What the viewer draws, whatever the engine (frontend spec sections 3 and 7).
 * Each engine's viewer reads that engine's Replay into a ViewerReplay, which
 * gives the Scene at any moment of the Game, between Ticks included; the
 * main view and the overview draw only Scenes. A Scene is visual only and
 * never changes what the Replay says.
 */

import type { Build, MapFormat1, Point } from "@positrontanks/ruleset-data";

/** A moment of a Game, in Ticks: 12 is the end of Tick 12, 12.5 halfway through Tick 13. */
export type Time = number;

export interface SceneBot {
  readonly id: number;
  /** Its Entry's index, in Entry order. */
  readonly entry: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /** In m/s, negative when reversing. */
  readonly speed: number;
  readonly hitPoints: number;
  readonly disabled: boolean;
}

export interface SceneProjectile {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A short effect drawn for an event. `age` runs from 0, when it happens, to
 * 1, when it is gone.
 */
export type Effect =
  /** A shot leaving a Bot. */
  | { readonly kind: "muzzle"; readonly at: Point; readonly heading: number; readonly age: number }
  /** A shot that crossed the space at once (a beam, or a melee strike), from its Bot to where it ended. */
  | { readonly kind: "beam"; readonly from: Point; readonly to: Point; readonly age: number }
  /** Where a shot ended; `hit` when it struck something. */
  | { readonly kind: "impact"; readonly at: Point; readonly hit: boolean; readonly age: number }
  /** A ram. */
  | { readonly kind: "collision"; readonly at: Point; readonly age: number }
  /** A Bot Disabled, or an Obstacle destroyed. */
  | { readonly kind: "explosion"; readonly at: Point; readonly age: number };

export interface Scene {
  readonly time: Time;
  /** Every Bot, in Bot id order. */
  readonly bots: readonly SceneBot[];
  readonly projectiles: readonly SceneProjectile[];
  readonly effects: readonly Effect[];
  /** The Map's Obstacles destroyed so far, by id. */
  readonly destroyedObstacles: ReadonlySet<string>;
}

export interface ViewerBot {
  readonly id: number;
  readonly name: string;
  readonly build: Build;
}

export interface ViewerEntry {
  /** The Player's id. */
  readonly player: string;
  /** In Bot id order. */
  readonly bots: readonly ViewerBot[];
}

/**
 * A hit that links two Bots (frontend spec section 7, Following a Bot): one
 * struck the other, by a shot or a ram. Misses link no one.
 */
export interface Hit {
  /** When it happened. */
  readonly time: Time;
  /** The two Bots' ids, in no particular order. */
  readonly bots: readonly [number, number];
}

/**
 * Hit Points a Bot lost (frontend spec section 7, Bot inset): what got past
 * Armor, to `target`, dealt by the Bot `dealer` (the one that fired, or the
 * other Bot in a ram), or by no Bot (a wreck, an Obstacle or the boundary).
 */
export interface Damage {
  readonly time: Time;
  readonly target: number;
  readonly dealer: number | null;
  readonly amount: number;
}

/** A Bot becoming Disabled, and why, as the engine names it (in r1, `destroyed` or `programHalted`). */
export interface Disablement {
  readonly time: Time;
  readonly bot: number;
  readonly cause: string;
}

/** A Replay, ready to watch. */
export interface ViewerReplay {
  readonly rulesetVersion: string;
  readonly tickRate: number;
  readonly map: MapFormat1;
  /** In Entry order. */
  readonly entries: readonly ViewerEntry[];
  /** The last Tick in the Replay; its Scene is the final frame. */
  readonly lastTick: number;
  /** Every hit between two different Bots, in time order. */
  readonly hits: readonly Hit[];
  /** Every Hit Point lost by a Bot, in time order. */
  readonly damage: readonly Damage[];
  /** Every Bot Disabled, in time order. */
  readonly disablements: readonly Disablement[];
  /** The Scene at `time`, which is kept within [0, lastTick]. */
  scene(time: Time): Scene;
}

/** The viewer for one engine's Replays. */
export interface EngineViewer {
  /** Reads a Replay as the API returns it; throws if it is not one of this engine's. */
  load(replay: unknown): ViewerReplay;
}

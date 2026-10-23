/**
 * What happened during a Tick, as `step` reports it. Replay events and win
 * condition accounting are built from these.
 */

import type { ArmorSide } from "@aumohta/ruleset-data";
import type { Point } from "./geometry.js";
import type { DisabledCause } from "./world.js";

/** What a moving Bot ran into. A wreck is a Disabled Bot. */
export type Collider =
  | { readonly kind: "bot"; readonly id: number }
  | { readonly kind: "wreck"; readonly id: number }
  | { readonly kind: "obstacle"; readonly id: string }
  | { readonly kind: "boundary" };

export type DamageTarget = { readonly kind: "bot"; readonly id: number } | { readonly kind: "obstacle"; readonly id: string };

/** Ramming: the target hit, or was hit by, `with`. */
export interface CollisionSource {
  readonly kind: "collision";
  readonly with: Collider;
}

export type DamageSource = CollisionSource;

export interface CollisionEvent {
  readonly type: "collision";
  readonly tick: number;
  /** The Bot whose movement was blocked. */
  readonly bot: number;
  readonly with: Collider;
  /** Closing speed along the contact direction, in m/s; 0 or less means no ram. */
  readonly closingSpeed: number;
  readonly point: Point;
}

export interface DamageEvent {
  readonly type: "damage";
  readonly tick: number;
  readonly target: DamageTarget;
  readonly source: DamageSource;
  /** Damage before Armor. */
  readonly raw: number;
  /** The part of `raw` the struck side's Armor absorbed. */
  readonly absorbed: number;
  /** Hit Points actually removed: what got past Armor, capped at the remaining Hit Points. */
  readonly dealt: number;
  /** The side struck, for a Bot; null for an Obstacle. */
  readonly side: ArmorSide | null;
  readonly point: Point;
  /** What took the damage: always the Chassis for a Bot in r1 (ADR-0004); null for an Obstacle. */
  readonly absorber: "chassis" | null;
}

export interface DisabledEvent {
  readonly type: "disabled";
  readonly tick: number;
  readonly bot: number;
  readonly cause: DisabledCause;
}

export interface ObstacleDestroyedEvent {
  readonly type: "obstacleDestroyed";
  readonly tick: number;
  readonly obstacle: string;
}

export type TickEvent = CollisionEvent | DamageEvent | DisabledEvent | ObstacleDestroyedEvent;

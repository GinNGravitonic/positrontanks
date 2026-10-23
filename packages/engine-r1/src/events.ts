/**
 * What happened during a Tick, as `step` reports it. Replay events and win
 * condition accounting are built from these.
 */

import type { ArmorSide } from "@aumohta/ruleset-data";
import type { WeaponCategory } from "./bot-spec.js";
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

/** A shot from `bot`'s weapon in Slot `weapon`. */
export interface WeaponSource {
  readonly kind: "weapon";
  readonly bot: number;
  readonly weapon: string;
  readonly category: WeaponCategory;
}

export type DamageSource = CollisionSource | WeaponSource;

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

/** A legal shot. */
export interface FiredEvent {
  readonly type: "fired";
  readonly tick: number;
  readonly bot: number;
  readonly weapon: string;
  readonly category: WeaponCategory;
  /** The muzzle. */
  readonly from: Point;
  /** The absolute direction of the shot. */
  readonly absBearing: number;
  /** The Projectile launched, for a Projectile Weapon; otherwise null. */
  readonly projectile: number | null;
}

/** Where a shot ended: what it hit, or null if it ran out of range there. */
export interface ImpactEvent {
  readonly type: "impact";
  readonly tick: number;
  readonly bot: number;
  readonly weapon: string;
  readonly projectile: number | null;
  readonly point: Point;
  readonly target: Collider | null;
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

export type TickEvent =
  | CollisionEvent
  | FiredEvent
  | ImpactEvent
  | DamageEvent
  | DisabledEvent
  | ObstacleDestroyedEvent;

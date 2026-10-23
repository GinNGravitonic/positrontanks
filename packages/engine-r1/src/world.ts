/**
 * The r1 world: Bots, live Obstacles and the Tick counter, created from a
 * Ruleset, a Map, the Entries and the Game seed (spec section 2).
 *
 * The world is a mutable value advanced by `step` (tick.ts). Everything in it
 * is a function of the setup and the commands given to each Tick, so the same
 * inputs always reach the same state (ADR-0001); `hashWorld` fingerprints it.
 */

import type { Build, MapFormat1, Obstacle, Ruleset } from "@aumohta/ruleset-data";
import { checkRuleset, deriveBotSpec, type BotSpec, type WeaponCategory } from "./bot-spec.js";
import {
  boundsOverlap,
  placeShape,
  pointInShape,
  shapeBounds,
  shapesOverlap,
  type Bounds,
  type WorldShape,
} from "./geometry.js";
import { SeededRandom } from "./random.js";

/** The random stream the world itself draws from; Bot streams use their Bot id, from 1. */
export const WORLD_STREAM = 0;

/** Placement tries per Bot before a Spawn Zone counts as too crowded. */
export const SPAWN_ATTEMPTS = 1000;

export interface BotSetup {
  readonly name: string;
  /** A Build that validateBuild accepted under the setup's Ruleset. */
  readonly build: Build;
}

export interface EntrySetup {
  readonly bots: readonly BotSetup[];
}

export interface WorldSetup {
  /** A valid Ruleset that also passes checkRuleset. */
  readonly ruleset: Ruleset;
  /** A valid Map whose Terrains the Ruleset defines. */
  readonly map: MapFormat1;
  readonly entries: readonly EntrySetup[];
  /** The Game seed, an integer in [0, 2^32). */
  readonly seed: number;
}

/** `stopped` is reserved for later Rulesets (overheating) and never entered in r1. */
export type BotStatus = "active" | "stopped" | "disabled";
export type DisabledCause = "destroyed" | "programHalted";

export interface WeaponState {
  /** The Slot name. */
  readonly id: string;
  /** Ticks until the weapon can fire again; 0 when it is ready. */
  ticksUntilReady: number;
}

export interface BotState {
  /** Opaque and stable for the Game; Bots are numbered from 1 in Entry order. */
  readonly id: number;
  readonly name: string;
  /** The index of the Bot's Entry; Bots of the same Entry are Friends. */
  readonly entry: number;
  readonly spec: BotSpec;
  x: number;
  y: number;
  /** Absolute, in [0, 360). */
  heading: number;
  /** Signed, along the Heading, in m/s. */
  speed: number;
  /** In degrees/s, positive clockwise. */
  turnRate: number;
  /** The persistent commands, in [-1, 1]. */
  throttle: number;
  turn: number;
  hitPoints: number;
  status: BotStatus;
  disabledCause: DisabledCause | null;
  /** In the order of spec.weapons. */
  readonly weapons: WeaponState[];
}

export interface ObstacleState {
  readonly obstacle: Obstacle;
  readonly shape: WorldShape;
  readonly bounds: Bounds;
  /** Remaining Hit Points; null for a permanent Obstacle. */
  hitPoints: number | null;
}

/** A Projectile in flight: a point moving in a straight line. */
export interface ProjectileState {
  /** Numbered from 1 in firing order. */
  readonly id: number;
  /** The Bot that fired it, which it never hits. */
  readonly bot: number;
  /** The Slot name of the weapon that fired it. */
  readonly weapon: string;
  readonly category: WeaponCategory;
  readonly damage: number;
  /** Absolute direction of travel. */
  readonly heading: number;
  /** m/s. */
  readonly speed: number;
  x: number;
  y: number;
  /** Meters it may still travel before it is spent. */
  remaining: number;
}

export interface World {
  readonly ruleset: Ruleset;
  readonly map: MapFormat1;
  readonly seed: number;
  /** The last completed Tick; 0 before the first. */
  tick: number;
  /** In id order. Disabled Bots stay here as wrecks. */
  readonly bots: BotState[];
  /** Map Obstacles not yet destroyed, in Map order. */
  obstacles: ObstacleState[];
  /** In flight, in id order. */
  projectiles: ProjectileState[];
  /** The id the next Projectile fired gets. */
  nextProjectileId: number;
  /** The Spawn Zone index each Entry was assigned, by Entry index. */
  readonly spawnZones: readonly number[];
}

export function obstacleShape(o: Obstacle): WorldShape {
  return o.shape === "circle"
    ? { shape: "circle", x: o.x, y: o.y, radius: o.radius }
    : { shape: "polygon", points: o.points };
}

/** The Bot's current outline in world coordinates. */
export function botShape(bot: BotState): WorldShape {
  return placeShape(bot.spec.shape, bot.x, bot.y, bot.heading);
}

/** Whether the shape lies within the Map; touching the boundary is allowed. */
export function withinMap(map: MapFormat1, b: Bounds): boolean {
  return b.minX >= 0 && b.minY >= 0 && b.maxX <= map.width && b.maxY <= map.height;
}

/**
 * Assigns each Entry a Spawn Zone by seeded draw. Larger Entries choose
 * first (ties in Entry order), each uniformly among the remaining zones that
 * can hold it, in Map order; since any zone that fits a larger Entry also
 * fits a smaller one, this succeeds whenever any assignment exists.
 */
function assignSpawnZones(map: MapFormat1, entries: readonly EntrySetup[], random: SeededRandom): number[] {
  const order = entries.map((_, i) => i).sort((a, b) => {
    const diff = (entries[b]?.bots.length ?? 0) - (entries[a]?.bots.length ?? 0);
    return diff !== 0 ? diff : a - b;
  });
  const free = map.spawnZones.map((_, i) => i);
  const assigned: number[] = [];
  for (const entry of order) {
    const size = entries[entry]?.bots.length ?? 0;
    const fitting = free.filter((z) => (map.spawnZones[z]?.capacity ?? 0) >= size);
    if (fitting.length === 0) throw new Error(`no free Spawn Zone can hold Entry ${String(entry)} (${String(size)} Bots)`);
    const zone = fitting[random.nextInt(fitting.length)] ?? 0;
    free.splice(free.indexOf(zone), 1);
    assigned[entry] = zone;
  }
  return assigned;
}

/** Creates the world at Tick 0 with every Bot placed in its Entry's Spawn Zone. */
export function createWorld(setup: WorldSetup): World {
  const { ruleset, map, entries, seed } = setup;
  const errors = checkRuleset(ruleset);
  if (errors.length > 0) {
    throw new Error(`Ruleset unsupported by engine-r1: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  }
  if (entries.length < 1) throw new Error("a Game needs at least one Entry");
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.bots.length === 0) throw new Error("every Entry needs at least one Bot");
    for (const bot of entry.bots) {
      if (names.has(bot.name)) throw new Error(`duplicate Bot Name "${bot.name}"`);
      names.add(bot.name);
    }
  }

  const random = new SeededRandom(seed, WORLD_STREAM);
  const spawnZones = assignSpawnZones(map, entries, random);
  const obstacles = map.obstacles.map((obstacle): ObstacleState => {
    const shape = obstacleShape(obstacle);
    return { obstacle, shape, bounds: shapeBounds(shape), hitPoints: obstacle.destructible ? obstacle.hitPoints : null };
  });

  const bots: BotState[] = [];
  const placed: { shape: WorldShape; bounds: Bounds }[] = [];
  entries.forEach((entry, entryIndex) => {
    const zone = map.spawnZones[spawnZones[entryIndex] ?? 0];
    if (zone === undefined) throw new Error("Spawn Zone assignment failed");
    const zoneShape: WorldShape =
      zone.shape === "circle"
        ? { shape: "circle", x: zone.x, y: zone.y, radius: zone.radius }
        : { shape: "polygon", points: zone.points };
    const zoneBounds = shapeBounds(zoneShape);

    for (const setupBot of entry.bots) {
      const spec = deriveBotSpec(ruleset, setupBot.build);
      let position: { x: number; y: number; shape: WorldShape; bounds: Bounds } | undefined;
      for (let attempt = 0; attempt < SPAWN_ATTEMPTS && position === undefined; attempt++) {
        const x = zoneBounds.minX + random.next() * (zoneBounds.maxX - zoneBounds.minX);
        const y = zoneBounds.minY + random.next() * (zoneBounds.maxY - zoneBounds.minY);
        if (!pointInShape({ x, y }, zoneShape)) continue;
        const shape = placeShape(spec.shape, x, y, zone.heading);
        const bounds = shapeBounds(shape);
        if (!withinMap(map, bounds)) continue;
        const clear = (other: { shape: WorldShape; bounds: Bounds }) =>
          !boundsOverlap(bounds, other.bounds) || !shapesOverlap(shape, other.shape);
        if (obstacles.every(clear) && placed.every(clear)) position = { x, y, shape, bounds };
      }
      if (position === undefined) {
        throw new Error(`could not place Bot "${setupBot.name}" in Spawn Zone ${String(spawnZones[entryIndex])}`);
      }
      placed.push(position);
      bots.push({
        id: bots.length + 1,
        name: setupBot.name,
        entry: entryIndex,
        spec,
        x: position.x,
        y: position.y,
        heading: zone.heading,
        speed: 0,
        turnRate: 0,
        throttle: 0,
        turn: 0,
        hitPoints: spec.maxHitPoints,
        status: "active",
        disabledCause: null,
        weapons: spec.weapons.map((w) => ({ id: w.id, ticksUntilReady: 0 })),
      });
    }
  });

  return { ruleset, map, seed, tick: 0, bots, obstacles, projectiles: [], nextProjectileId: 1, spawnZones };
}

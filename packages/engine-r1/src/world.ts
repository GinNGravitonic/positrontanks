/**
 * The r1 world: Bots, live Obstacles and the Tick counter, created from a
 * Ruleset, a Map, the Entries and the Game seed (spec section 2).
 *
 * The world is a mutable value advanced by `step` (tick.ts). Everything in it
 * is a function of the setup and the commands given to each Tick, so the same
 * inputs always reach the same state (ADR-0001); `hashWorld` fingerprints it.
 */

import type { Build, MapFormat1, Obstacle, Ruleset } from "@positrontanks/ruleset-data";
import { checkRuleset, deriveBotSpec, type BotSpec, type WeaponCategory } from "./bot-spec.js";
import {
  boundsOverlap,
  headingVector,
  placeShape,
  pointInShape,
  shapeBounds,
  shapesOverlap,
  type Bounds,
  type WorldShape,
} from "./geometry.js";
import { hypot } from "./math.js";
import { SeededRandom } from "./random.js";

/** The random stream the world itself draws from; Bot streams use their Bot id, from 1. */
export const WORLD_STREAM = 0;

/** Placement tries per Bot before a Spawn Zone counts as too crowded. */
export const SPAWN_ATTEMPTS = 1000;

/**
 * Meters between the rings of the spill search, and roughly between the
 * candidate centres along each ring.
 */
export const SPILL_SPACING = 0.5;

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
 * can hold it, in Map order. An Entry no free zone can hold takes the
 * largest free zone, drawn among equals, and its overflow Bots spill.
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
    if (free.length === 0) throw new Error(`no free Spawn Zone for Entry ${String(entry)}`);
    const capacity = (z: number) => map.spawnZones[z]?.capacity ?? 0;
    let fitting = free.filter((z) => capacity(z) >= size);
    if (fitting.length === 0) {
      const largest = Math.max(...free.map(capacity));
      fitting = free.filter((z) => capacity(z) === largest);
    }
    const zone = fitting[random.nextInt(fitting.length)] ?? 0;
    free.splice(free.indexOf(zone), 1);
    assigned[entry] = zone;
  }
  return assigned;
}

function zoneShape(zone: MapFormat1["spawnZones"][number]): WorldShape {
  return zone.shape === "circle"
    ? { shape: "circle", x: zone.x, y: zone.y, radius: zone.radius }
    : { shape: "polygon", points: zone.points };
}

interface Occupied {
  readonly shape: WorldShape;
  readonly bounds: Bounds;
}

interface Placement extends Occupied {
  readonly x: number;
  readonly y: number;
}

/** Whether a shape with these bounds touches none of `others`. */
function clearOf(shape: WorldShape, bounds: Bounds, others: readonly Occupied[]): boolean {
  return others.every((o) => !boundsOverlap(bounds, o.bounds) || !shapesOverlap(shape, o.shape));
}

/**
 * The nearest free spot around a Spawn Zone's centre (the centre of its
 * bounding box), for a Bot over the zone's capacity or one the random tries
 * could not place. Candidate centres lie on rings SPILL_SPACING apart, the
 * centre itself first; ring k holds 6k candidates evenly spaced by bearing,
 * clockwise from 0 (up the Map). The first where the Bot lies within the Map
 * and touches no Obstacle, placed Bot or other Spawn Zone wins. Draws no
 * random numbers.
 */
function spillPlacement(
  map: MapFormat1,
  local: BotSpec["shape"],
  heading: number,
  zoneBounds: Bounds,
  blocked: readonly Occupied[],
  otherZones: readonly Occupied[],
): Placement | undefined {
  const cx = (zoneBounds.minX + zoneBounds.maxX) / 2;
  const cy = (zoneBounds.minY + zoneBounds.maxY) / 2;
  // No point of the Map is farther from the centre than the Map's diagonal.
  const rings = Math.ceil(hypot(map.width, map.height) / SPILL_SPACING);
  for (let ring = 0; ring <= rings; ring++) {
    const radius = ring * SPILL_SPACING;
    const count = ring === 0 ? 1 : 6 * ring;
    for (let i = 0; i < count; i++) {
      const direction = headingVector((i * 360) / count);
      const x = cx + direction.x * radius;
      const y = cy + direction.y * radius;
      const shape = placeShape(local, x, y, heading);
      const bounds = shapeBounds(shape);
      if (withinMap(map, bounds) && clearOf(shape, bounds, blocked) && clearOf(shape, bounds, otherZones)) {
        return { x, y, shape, bounds };
      }
    }
  }
  return undefined;
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
  const placed: Occupied[] = [];
  const zones = map.spawnZones.map((zone): Occupied => {
    const shape = zoneShape(zone);
    return { shape, bounds: shapeBounds(shape) };
  });
  entries.forEach((entry, entryIndex) => {
    const zoneIndex = spawnZones[entryIndex] ?? 0;
    const zone = map.spawnZones[zoneIndex];
    const area = zones[zoneIndex];
    if (zone === undefined || area === undefined) throw new Error("Spawn Zone assignment failed");

    entry.bots.forEach((setupBot, botIndex) => {
      const spec = deriveBotSpec(ruleset, setupBot.build);
      let position: Placement | undefined;
      // Bots over the zone's capacity skip the random tries and draw nothing.
      const attempts = botIndex < zone.capacity ? SPAWN_ATTEMPTS : 0;
      for (let attempt = 0; attempt < attempts && position === undefined; attempt++) {
        const x = area.bounds.minX + random.next() * (area.bounds.maxX - area.bounds.minX);
        const y = area.bounds.minY + random.next() * (area.bounds.maxY - area.bounds.minY);
        if (!pointInShape({ x, y }, area.shape)) continue;
        const shape = placeShape(spec.shape, x, y, zone.heading);
        const bounds = shapeBounds(shape);
        if (!withinMap(map, bounds)) continue;
        if (clearOf(shape, bounds, obstacles) && clearOf(shape, bounds, placed)) position = { x, y, shape, bounds };
      }
      if (position === undefined) {
        const others = zones.filter((_, i) => i !== zoneIndex);
        position = spillPlacement(map, spec.shape, zone.heading, area.bounds, [...obstacles, ...placed], others);
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
    });
  });

  return { ruleset, map, seed, tick: 0, bots, obstacles, projectiles: [], nextProjectileId: 1, spawnZones };
}

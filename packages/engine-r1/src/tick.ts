/**
 * The r1 Tick: commands, weapon fire, kinematics, movement, collisions and
 * Projectiles (spec section 2; the rules are in ruleset-data/spec/r1/engine-r1.md).
 *
 * Movement is resolved in substeps short enough that nothing tunnels through
 * a thin Obstacle. In each substep every moving Bot proposes its full move;
 * a Bot whose proposal is blocked falls back to turning in place, then to
 * staying put, until no proposals overlap. Blocking is decided for all Bots
 * at once from the proposals, never in Bot order, so the result does not
 * depend on how Bots are numbered.
 */

import type { MapFormat1 } from "@aumohta/ruleset-data";
import { damageBot, damageObstacle } from "./damage.js";
import type { Collider, TickEvent } from "./events.js";
import {
  boundsOverlap,
  contact,
  headingVector,
  placeShape,
  shapeBounds,
  shapesOverlap,
  type Bounds,
  type Contact,
  type Point,
  type WorldShape,
} from "./geometry.js";
import { normalizeAbsAngle } from "./math.js";
import { terrainAt } from "./terrain.js";
import { advanceProjectiles, fireWeapons, reloadWeapons, type FireTarget } from "./weapons.js";
import { botShape, withinMap, type BotState, type World } from "./world.js";

/** The longest distance any point of a Bot may travel in one substep, in meters. */
export const SUBSTEP_LENGTH = 0.05;
/** The most substeps one Tick is split into. */
export const MAX_SUBSTEPS = 100;
/** Collisions closing slower than this, in m/s, deal no damage (catalog-r1 §6). */
export const MIN_RAM_SPEED = 3;
/** Ramming damage per joule of collision energy (catalog-r1 §6). */
export const RAM_DAMAGE_PER_JOULE = 0.01;

/**
 * The commands a Bot's Program issued this Tick. Omitted movement commands
 * keep their previous value; `fire` gives this Tick's aim per weapon id.
 */
export interface BotCommands {
  readonly throttle?: number;
  readonly turn?: number;
  readonly fire?: Readonly<Record<string, FireTarget>>;
}

function clampCommand(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${what} must be finite, got ${String(v)}`);
  return Math.max(-1, Math.min(1, v));
}

/** Terrain speed and acceleration multipliers for a Bot at its current position. */
export function terrainMultipliers(world: World, bot: BotState): { speed: number; accel: number } {
  const name = terrainAt(world.map, bot);
  const terrain = world.ruleset.terrains.find((t) => t.name === name);
  const motor = Object.hasOwn(bot.spec.motorTerrain, name) ? bot.spec.motorTerrain[name] : undefined;
  return {
    speed: (terrain?.speed ?? 1) * (motor?.speed ?? 1),
    accel: (terrain?.accel ?? 1) * (motor?.accel ?? 1),
  };
}

/** Sets the Bot's speed and turn rate for this Tick from its commands and the Terrain under it. */
function updateKinematics(world: World, bot: BotState): void {
  if (bot.status === "disabled") return;
  const throttle = bot.status === "active" ? bot.throttle : 0;
  const turn = bot.status === "active" ? bot.turn : 0;
  const m = terrainMultipliers(world, bot);
  const target = throttle * bot.spec.topSpeed * m.speed;
  const delta = (bot.spec.accel * m.accel) / world.ruleset.tickRate;
  bot.speed = target > bot.speed ? Math.min(target, bot.speed + delta) : Math.max(target, bot.speed - delta);
  bot.turnRate = turn * bot.spec.turnRate;
}

interface Pose {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly shape: WorldShape;
  readonly bounds: Bounds;
}

/** A Bot taking part in movement this Tick. */
interface Mover {
  readonly bot: BotState;
  /** Per substep. */
  readonly dHeading: number;
  /** Whether its translation has not been blocked yet this Tick. */
  translating: boolean;
}

/** 0: move and turn; 1: turn in place; 2: stay. */
type Level = 0 | 1 | 2;

function poseOf(bot: BotState): Pose {
  const shape = botShape(bot);
  return { x: bot.x, y: bot.y, heading: bot.heading, shape, bounds: shapeBounds(shape) };
}

function propose(mover: Mover, from: Pose, level: Level, distance: number): Pose {
  if (level === 2) return from;
  const heading = normalizeAbsAngle(from.heading + mover.dHeading);
  const v = headingVector(heading);
  const x = level === 0 ? from.x + v.x * distance : from.x;
  const y = level === 0 ? from.y + v.y * distance : from.y;
  const shape = placeShape(mover.bot.spec.shape, x, y, heading);
  return { x, y, heading, shape, bounds: shapeBounds(shape) };
}

function overlaps(a: Pose, b: Pose): boolean {
  return boundsOverlap(a.bounds, b.bounds) && shapesOverlap(a.shape, b.shape);
}

/** Static things a pose runs into: the boundary, live Obstacles and wrecks. */
function staticHits(world: World, wrecks: readonly { bot: BotState; pose: Pose }[], pose: Pose): Collider[] {
  const hits: Collider[] = [];
  if (!withinMap(world.map, pose.bounds)) hits.push({ kind: "boundary" });
  for (const o of world.obstacles) {
    // One destroyed this Tick still blocks until it is removed at the Tick's end.
    if (boundsOverlap(pose.bounds, o.bounds) && shapesOverlap(pose.shape, o.shape)) {
      hits.push({ kind: "obstacle", id: o.obstacle.id });
    }
  }
  for (const w of wrecks) if (overlaps(pose, w.pose)) hits.push({ kind: "wreck", id: w.bot.id });
  return hits;
}

/**
 * Where a Bot at `from` meets the Map boundary it was pushing past in `to`:
 * the wall it overshot most (ties: left, top, right, bottom), at the point
 * level with its centre, with the wall's outward normal.
 */
function boundaryContact(map: MapFormat1, from: Pose, to: Bounds): Contact {
  const walls: [number, Contact][] = [
    [-to.minX, { point: { x: 0, y: from.y }, normal: { x: -1, y: 0 } }],
    [-to.minY, { point: { x: from.x, y: 0 }, normal: { x: 0, y: -1 } }],
    [to.maxX - map.width, { point: { x: map.width, y: from.y }, normal: { x: 1, y: 0 } }],
    [to.maxY - map.height, { point: { x: from.x, y: map.height }, normal: { x: 0, y: 1 } }],
  ];
  let best = walls[0];
  for (const wall of walls) if (best === undefined || wall[0] > best[0]) best = wall;
  if (best === undefined) throw new Error("unreachable");
  return best[1];
}

function velocity(bot: BotState, heading: number): Point {
  const v = headingVector(heading);
  return { x: v.x * bot.speed, y: v.y * bot.speed };
}

/** How fast a body with velocity `va` closes on one with velocity `vb` along `normal`. */
function closing(normal: Point, va: Point, vb: Point): number {
  return (va.x - vb.x) * normal.x + (va.y - vb.y) * normal.y;
}

/** Orders a pair of poses by position, so the pair is handled the same whichever Bot has the lower id. */
function firstByPosition(a: Pose, b: Pose): boolean {
  return a.x < b.x || (a.x === b.x && a.y < b.y);
}

function ramDamage(closingSpeed: number, reducedMass: number): number {
  if (closingSpeed < MIN_RAM_SPEED) return 0;
  return RAM_DAMAGE_PER_JOULE * 0.5 * reducedMass * closingSpeed * closingSpeed;
}

/** One substep: resolves every mover's proposal, moves them, and applies ramming. */
function substep(world: World, movers: readonly Mover[], distances: readonly number[], events: TickEvent[]): void {
  const tick = world.tick;
  const wrecks = world.bots.filter((b) => b.status === "disabled").map((bot) => ({ bot, pose: poseOf(bot) }));
  const from = movers.map((m) => poseOf(m.bot));
  const levels: Level[] = movers.map((m, i) => {
    if (m.bot.status === "disabled") return 2;
    if (m.translating && distances[i] !== 0) return 0;
    return m.dHeading !== 0 ? 1 : 2;
  });
  const lower = (i: number): Level => {
    const level = levels[i] ?? 2;
    if (level === 0 && (movers[i]?.dHeading ?? 0) !== 0) return 1;
    return 2;
  };
  const proposals = movers.map((m, i) => propose(m, from[i] ?? poseOf(m.bot), levels[i] ?? 2, distances[i] ?? 0));
  /** What blocked each mover's translation, for those blocked this substep. */
  const blockers = new Map<number, Collider[]>();

  for (;;) {
    const blocked = new Map<number, Collider[]>();
    const block = (i: number, c: Collider) => {
      const list = blocked.get(i);
      if (list === undefined) blocked.set(i, [c]);
      else list.push(c);
    };
    movers.forEach((_, i) => {
      if (levels[i] === 2) return;
      const p = proposals[i];
      if (p !== undefined) for (const c of staticHits(world, wrecks, p)) block(i, c);
    });
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i];
        const b = movers[j];
        const pa = proposals[i];
        const pb = proposals[j];
        const fa = from[i];
        const fb = from[j];
        if (a === undefined || b === undefined || pa === undefined || pb === undefined) continue;
        if (fa === undefined || fb === undefined) continue;
        if (a.bot.status === "disabled" || b.bot.status === "disabled") continue; // wrecks are static hits
        if (levels[i] === 2 && levels[j] === 2) continue;
        if (!overlaps(pa, pb)) continue;
        // Blame whichever Bot moved into the other's old place; if both or
        // neither did, both are blocked.
        const aInto = levels[i] !== 2 && overlaps(pa, fb);
        const bInto = levels[j] !== 2 && overlaps(fa, pb);
        if ((aInto || !bInto) && levels[i] !== 2) block(i, { kind: "bot", id: b.bot.id });
        if ((bInto || !aInto) && levels[j] !== 2) block(j, { kind: "bot", id: a.bot.id });
      }
    }
    if (blocked.size === 0) break;
    for (const [i, colliders] of blocked) {
      if (levels[i] === 0) blockers.set(i, colliders);
      const next = lower(i);
      levels[i] = next;
      const m = movers[i];
      const f = from[i];
      if (m !== undefined && f !== undefined) proposals[i] = propose(m, f, next, distances[i] ?? 0);
    }
  }

  // Ramming uses the poses and speeds from before this substep's move.
  const velocities = movers.map((m, i) => velocity(m.bot, from[i]?.heading ?? m.bot.heading));
  const rammed = new Set<string>();
  for (const [i, colliders] of blockers) {
    const mover = movers[i];
    const f = from[i];
    const va = velocities[i];
    if (mover === undefined || f === undefined || va === undefined) continue;
    const bot = mover.bot;
    for (const c of colliders) {
      if (c.kind === "bot") {
        const j = movers.findIndex((m) => m.bot.id === c.id);
        const other = movers[j];
        const fo = from[j];
        const vo = velocities[j];
        if (other === undefined || fo === undefined || vo === undefined) continue;
        const contactOf = (): { point: Point; speed: number } => {
          if (firstByPosition(f, fo)) {
            const k = contact(f.shape, fo.shape);
            return { point: k.point, speed: closing(k.normal, va, vo) };
          }
          const k = contact(fo.shape, f.shape);
          return { point: k.point, speed: closing(k.normal, vo, va) };
        };
        const { point, speed } = contactOf();
        events.push({ type: "collision", tick, bot: bot.id, with: c, closingSpeed: speed, point });
        const key = `${String(Math.min(bot.id, c.id))}:${String(Math.max(bot.id, c.id))}`;
        if (rammed.has(key)) continue;
        rammed.add(key);
        const reduced = (bot.spec.mass * other.bot.spec.mass) / (bot.spec.mass + other.bot.spec.mass);
        const raw = ramDamage(speed, reduced);
        // Lower id first, so the events come out in the same order however the pair was found.
        const [first, second] = bot.id < other.bot.id ? [bot, other.bot] : [other.bot, bot];
        damageBot(first, raw, point, { kind: "collision", with: { kind: "bot", id: second.id } }, tick, events);
        damageBot(second, raw, point, { kind: "collision", with: { kind: "bot", id: first.id } }, tick, events);
        continue;
      }
      let k: Contact;
      if (c.kind === "boundary") k = boundaryContact(world.map, f, proposals[i]?.bounds ?? f.bounds);
      else if (c.kind === "wreck") k = contact(f.shape, botShape(world.bots[c.id - 1] ?? bot));
      else k = contact(f.shape, world.obstacles.find((o) => o.obstacle.id === c.id)?.shape ?? f.shape);
      const { point } = k;
      const speed = closing(k.normal, va, { x: 0, y: 0 });
      events.push({ type: "collision", tick, bot: bot.id, with: c, closingSpeed: speed, point });
      const raw = ramDamage(speed, bot.spec.mass);
      damageBot(bot, raw, point, { kind: "collision", with: c }, tick, events);
      if (c.kind === "obstacle") {
        const o = world.obstacles.find((s) => s.obstacle.id === c.id);
        if (o !== undefined) damageObstacle(o, raw, point, { kind: "collision", with: { kind: "bot", id: bot.id } }, tick, events);
      }
    }
  }

  movers.forEach((m, i) => {
    const p = proposals[i];
    if (p === undefined || m.bot.status === "disabled") return;
    m.bot.x = p.x;
    m.bot.y = p.y;
    m.bot.heading = p.heading;
    if (blockers.has(i)) {
      m.translating = false;
      m.bot.speed = 0;
    }
  });
}

/**
 * Advances the world by one Tick. `commands` holds what each Bot's Program
 * issued this Tick, by Bot id; Bots without an entry keep their commands.
 * Commands for Bots that are not active are ignored, and illegal shots do
 * nothing. Returns what happened.
 */
export function step(world: World, commands: ReadonlyMap<number, BotCommands> = new Map()): TickEvent[] {
  world.tick += 1;
  const events: TickEvent[] = [];
  const dt = 1 / world.ruleset.tickRate;

  for (const bot of world.bots) {
    const c = commands.get(bot.id);
    if (c === undefined || bot.status !== "active") continue;
    if (c.throttle !== undefined) bot.throttle = clampCommand(c.throttle, "throttle");
    if (c.turn !== undefined) bot.turn = clampCommand(c.turn, "turn");
  }
  const orders = new Map<number, Readonly<Record<string, FireTarget>>>();
  for (const [id, c] of commands) if (c.fire !== undefined) orders.set(id, c.fire);
  fireWeapons(world, orders, events);
  for (const bot of world.bots) updateKinematics(world, bot);

  // The farthest any point of a Bot moves this Tick: along its Heading, plus
  // its outline sweeping round as it turns.
  let travel = 0;
  for (const bot of world.bots) {
    if (bot.status === "disabled") continue;
    travel = Math.max(travel, Math.abs(bot.speed) * dt + ((Math.abs(bot.turnRate) * dt * Math.PI) / 180) * bot.spec.reach);
  }
  // Projectiles move in step with the Bots, after them in each substep.
  const substeps = travel > 0 ? Math.min(MAX_SUBSTEPS, Math.ceil(travel / SUBSTEP_LENGTH)) : 1;
  // Every Bot takes part, so moving Bots also run into stationary ones and wrecks.
  const movers: Mover[] = world.bots.map((bot) => ({
    bot,
    dHeading: bot.status === "disabled" ? 0 : (bot.turnRate * dt) / substeps,
    translating: bot.status !== "disabled",
  }));
  for (let k = 0; k < substeps; k++) {
    if (travel > 0) {
      const distances = movers.map((m) => (m.translating ? (m.bot.speed * dt) / substeps : 0));
      substep(world, movers, distances, events);
    }
    if (world.projectiles.length > 0) advanceProjectiles(world, dt / substeps, events);
  }

  reloadWeapons(world);
  world.obstacles = world.obstacles.filter((o) => o.hitPoints !== 0);
  return events;
}

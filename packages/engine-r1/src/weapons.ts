/**
 * Weapon fire: aiming, legality, instant Melee and Beam shots, and Projectiles
 * in flight (spec section 2, Weapons; the rules are in ruleset-data/spec/r1/engine-r1.md
 * section 6).
 *
 * Every shot is aimed, measured and traced as a ray (rays.ts) from the Bot's
 * centre, whichever Slot the weapon is in, and never stops at the Bot that
 * fired it. The Slot sets only the direction of the Firing Arc.
 */

import type { WeaponSpec } from "./bot-spec.js";
import { damageBot, damageObstacle } from "./damage.js";
import type { Collider, TickEvent, WeaponSource } from "./events.js";
import { headingVector, inArc, pointInShape, type Point } from "./geometry.js";
import { atan2Deg, normalizeAbsAngle } from "./math.js";
import { along, castRay, type RayHit } from "./rays.js";
import type { BotState, ProjectileState, World } from "./world.js";

/** What a `fire` or `fireAbs` call aims at: a point, a bearing relative to the Heading, or an absolute bearing. */
export type FireTarget =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "bearing"; readonly bearing: number }
  | { readonly kind: "absBearing"; readonly bearing: number };

/** The weapon in Slot `weaponId`; throws if the Bot has none there. */
export function weaponOf(bot: BotState, weaponId: string): { spec: WeaponSpec; index: number } {
  const index = bot.spec.weapons.findIndex((w) => w.id === weaponId);
  const spec = bot.spec.weapons[index];
  if (spec === undefined) throw new RangeError(`Bot ${String(bot.id)} has no weapon "${weaponId}"`);
  return { spec, index };
}

function finite(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${what} must be finite, got ${String(v)}`);
  return v;
}

/** The absolute direction of a shot from `from`, or null when aimed at `from` itself. */
function aimBearing(bot: BotState, from: Point, target: FireTarget): number | null {
  switch (target.kind) {
    case "point": {
      const dx = finite(target.x, "target x") - from.x;
      const dy = finite(target.y, "target y") - from.y;
      if (dx === 0 && dy === 0) return null;
      return normalizeAbsAngle(atan2Deg(dx, -dy));
    }
    case "bearing":
      return normalizeAbsAngle(bot.heading + finite(target.bearing, "bearing"));
    case "absBearing":
      return normalizeAbsAngle(finite(target.bearing, "bearing"));
  }
}

/** Whether an absolute bearing lies within the weapon's Firing Arc, ends included. */
export function inFiringArc(bot: BotState, weapon: WeaponSpec, absBearing: number): boolean {
  return inArc(bot.heading, weapon.direction, weapon.arcWidth, absBearing);
}

/** A legal shot: its weapon, where it starts and its absolute direction. */
interface Shot {
  readonly weapon: WeaponSpec;
  readonly index: number;
  readonly from: Point;
  readonly absBearing: number;
}

function aim(world: World, bot: BotState, weaponId: string, target: FireTarget): Shot | null {
  const { spec: weapon, index } = weaponOf(bot, weaponId);
  if (bot.status !== "active") return null;
  if ((bot.weapons[index]?.ticksUntilReady ?? 0) > 0) return null;
  const from = { x: bot.x, y: bot.y };
  const absBearing = aimBearing(bot, from, target);
  if (absBearing === null || !inFiringArc(bot, weapon, absBearing)) return null;
  if (target.kind === "point") {
    // Line of fire: nothing in the way but what the point lies in, or a Bot.
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const hit = castRay(world, from, headingVector(absBearing), Math.sqrt(dx * dx + dy * dy), bot.id, false);
    const blocking = hit.target?.kind === "obstacle" || hit.target?.kind === "wreck";
    if (blocking && hit.shape !== null && !pointInShape(target, hit.shape)) return null;
  }
  return { weapon, index, from, absBearing };
}

/**
 * Whether the Bot may fire the weapon in Slot `weaponId` at `target` in the
 * world as it stands: the Bot is active, the weapon has reloaded, the aim is
 * within the Firing Arc, and line of fire is clear. Throws for a weapon the
 * Bot does not have, or a non-finite aim.
 */
export function canFire(world: World, bot: BotState, weaponId: string, target: FireTarget): boolean {
  return aim(world, bot, weaponId, target) !== null;
}

function strike(
  world: World,
  source: WeaponSource,
  damage: number,
  target: Collider | null,
  point: Point,
  events: TickEvent[],
): void {
  if (target?.kind === "bot") {
    const b = world.bots[target.id - 1];
    if (b !== undefined) damageBot(b, damage, point, source, world.tick, events);
  } else if (target?.kind === "obstacle") {
    const o = world.obstacles.find((s) => s.obstacle.id === target.id);
    if (o !== undefined) damageObstacle(o, damage, point, source, world.tick, events);
  }
}

/**
 * Fires every legal shot ordered this Tick, by Bot id then Slot order: Melee
 * and Beam shots hit at once, and Projectiles are launched. All shots are
 * judged and traced before any damage is dealt, so they are simultaneous.
 * `orders` gives each Bot's aim per weapon id.
 */
export function fireWeapons(
  world: World,
  orders: ReadonlyMap<number, Readonly<Record<string, FireTarget>>>,
  events: TickEvent[],
): void {
  const instant: { source: WeaponSource; damage: number; hit: RayHit; from: Point; dir: Point }[] = [];
  for (const bot of world.bots) {
    const fire = orders.get(bot.id);
    if (fire === undefined || bot.status !== "active") continue;
    for (const id of Object.keys(fire)) weaponOf(bot, id); // rejects unknown weapons
    const shots: Shot[] = [];
    for (const weapon of bot.spec.weapons) {
      const target = Object.hasOwn(fire, weapon.id) ? fire[weapon.id] : undefined;
      if (target === undefined) continue;
      const shot = aim(world, bot, weapon.id, target);
      if (shot !== null) shots.push(shot);
    }
    for (const { weapon, index, from, absBearing } of shots) {
      const state = bot.weapons[index];
      if (state !== undefined) state.ticksUntilReady = weapon.reloadTicks;
      const source: WeaponSource = { kind: "weapon", bot: bot.id, weapon: weapon.id, category: weapon.category };
      const dir = headingVector(absBearing);
      let projectile: number | null = null;
      if (weapon.category === "projectile") {
        projectile = world.nextProjectileId++;
        world.projectiles.push({
          id: projectile,
          bot: bot.id,
          weapon: weapon.id,
          category: weapon.category,
          damage: weapon.damage,
          heading: absBearing,
          speed: weapon.projectileSpeed,
          x: from.x,
          y: from.y,
          remaining: weapon.range,
        });
      } else {
        instant.push({ source, damage: weapon.damage, hit: castRay(world, from, dir, weapon.range, bot.id, true), from, dir });
      }
      events.push({ type: "fired", tick: world.tick, bot: bot.id, weapon: weapon.id, category: weapon.category, from, absBearing, projectile });
    }
  }
  for (const { source, damage, hit, from, dir } of instant) {
    const point = along(from, dir, hit.distance);
    events.push({ type: "impact", tick: world.tick, bot: source.bot, weapon: source.weapon, projectile: null, point, target: hit.target });
    strike(world, source, damage, hit.target, point, events);
  }
}

/**
 * Moves every Projectile on by `dt` seconds of flight against the world as
 * it now stands. Those that hit something, or run out of range, are removed.
 * All paths are traced before any damage is dealt.
 */
export function advanceProjectiles(world: World, dt: number, events: TickEvent[]): void {
  const landed: { p: ProjectileState; hit: RayHit; point: Point }[] = [];
  for (const p of world.projectiles) {
    const dir = headingVector(p.heading);
    const from = { x: p.x, y: p.y };
    const hit = castRay(world, from, dir, Math.min(p.speed * dt, p.remaining), p.bot, true);
    const point = along(from, dir, hit.distance);
    p.x = point.x;
    p.y = point.y;
    p.remaining -= hit.distance;
    if (hit.target !== null || p.remaining <= 0) landed.push({ p, hit, point });
  }
  if (landed.length === 0) return;
  for (const { p, hit, point } of landed) {
    events.push({ type: "impact", tick: world.tick, bot: p.bot, weapon: p.weapon, projectile: p.id, point, target: hit.target });
    const source: WeaponSource = { kind: "weapon", bot: p.bot, weapon: p.weapon, category: p.category };
    strike(world, source, p.damage, hit.target, point, events);
  }
  const gone = new Set(landed.map((l) => l.p));
  world.projectiles = world.projectiles.filter((p) => !gone.has(p));
}

/** Counts every weapon's reload down by one Tick. */
export function reloadWeapons(world: World): void {
  for (const bot of world.bots) for (const w of bot.weapons) if (w.ticksUntilReady > 0) w.ticksUntilReady -= 1;
}

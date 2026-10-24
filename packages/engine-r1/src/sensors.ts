/**
 * Sensors: Radar, Rangefinder and Projectile Detector (spec section 2,
 * Sensors and knowledge; the rules are in docs/spec/engine-r1.md section 9).
 *
 * A sensor looks from the Bot's centre, whichever Slot it is in, within an
 * arc centred on the Slot direction; ranges, distances and bearings are all
 * measured from the centre, as `distanceTo`, `bearingTo` and weapon fire are,
 * so a Program can aim at what it sees. Every reading is taken from the
 * world as it stands, which while Programs run is the snapshot at the start
 * of the Tick.
 */

import type { SensorKind, SensorSpec, WeaponCategory } from "./bot-spec.js";
import { absBearing, headingVector, inArc, type Point } from "./geometry.js";
import { normalizeAbsAngle, normalizeAngle } from "./math.js";
import { castRay, lineOfSight } from "./rays.js";
import type { BotState, World } from "./world.js";

/** A Bot seen by Radar, as `scan()` reports it. */
export interface RadarContact {
  /** The Bot id. */
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
  /** Relative to the scanning Bot's Heading, in (-180, 180]. */
  readonly bearing: number;
  readonly absBearing: number;
  readonly heading: number;
  readonly speed: number;
  readonly isFoe: boolean;
}

/** What a Rangefinder's ray met first, as `rangefind()` reports it. Wrecks count as Obstacles. */
export interface RangefinderReading {
  readonly distance: number;
  readonly hit: "bot" | "obstacle" | "boundary";
}

/** A Projectile on a collision course, as `incoming()` reports it. */
export interface IncomingProjectile {
  /** Of the Projectile's position, relative to the Bot's Heading. */
  readonly bearing: number;
  /** The Tick, counting this one as 1, in which it would hit the Bot if the Bot stayed still. */
  readonly ticksToImpact: number;
  readonly category: WeaponCategory;
}

function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether the point is within the sensor's range and arc of the Bot's centre. */
function covers(bot: BotState, sensor: SensorSpec, p: Point): boolean {
  return distance(bot, p) <= sensor.range && inArc(bot.heading, sensor.direction, sensor.arcWidth, absBearing(bot, p));
}

function sensorsOf(bot: BotState, kind: SensorKind): SensorSpec[] {
  return bot.spec.sensors.filter((s) => s.kind === kind);
}

/**
 * Every other Bot that is not Disabled and that any of the Bot's Radars sees,
 * in id order: its centre is within the Radar's range and arc, with line of
 * sight between the two Bots' centres.
 */
export function scan(world: World, bot: BotState): RadarContact[] {
  const radars = sensorsOf(bot, "radar");
  if (radars.length === 0) return [];
  const contacts: RadarContact[] = [];
  for (const other of world.bots) {
    if (other.id === bot.id || other.status === "disabled") continue;
    if (!radars.some((radar) => covers(bot, radar, other)) || !lineOfSight(world, bot, other)) continue;
    const abs = absBearing(bot, other);
    contacts.push({
      id: other.id,
      name: other.name,
      x: other.x,
      y: other.y,
      distance: distance(bot, other),
      bearing: normalizeAngle(abs - bot.heading),
      absBearing: abs,
      heading: other.heading,
      speed: other.speed,
      isFoe: other.entry !== bot.entry,
    });
  }
  return contacts;
}

/**
 * The first thing a ray from the Bot's centre along the Slot direction of the
 * Rangefinder in Slot `sensorId` meets within its range, ignoring the Bot
 * itself, or null. Throws if the Bot has no Rangefinder there.
 */
export function rangefind(world: World, bot: BotState, sensorId: string): RangefinderReading | null {
  const sensor = bot.spec.sensors.find((s) => s.id === sensorId && s.kind === "rangefinder");
  if (sensor === undefined) throw new RangeError(`Bot ${String(bot.id)} has no rangefinder "${sensorId}"`);
  const dir = headingVector(normalizeAbsAngle(bot.heading + sensor.direction));
  const hit = castRay(world, bot, dir, sensor.range, bot.id, true);
  if (hit.target === null) return null;
  return { distance: hit.distance, hit: hit.target.kind === "bot" || hit.target.kind === "boundary" ? hit.target.kind : "obstacle" };
}

/**
 * Every Projectile, in id order, that one of the Bot's Projectile Detectors
 * covers and that is on a collision course: carrying on as it is, with
 * everything else staying still, the first thing it would hit within its
 * remaining range is this Bot.
 */
export function incoming(world: World, bot: BotState): IncomingProjectile[] {
  const detectors = sensorsOf(bot, "projectileDetector");
  if (detectors.length === 0) return [];
  const found: IncomingProjectile[] = [];
  for (const p of world.projectiles) {
    if (!detectors.some((detector) => covers(bot, detector, p))) continue;
    const hit = castRay(world, p, headingVector(p.heading), p.remaining, p.bot, true);
    if (hit.target?.kind !== "bot" || hit.target.id !== bot.id) continue;
    const perTick = p.speed / world.ruleset.tickRate;
    found.push({
      bearing: normalizeAngle(absBearing(bot, p) - bot.heading),
      ticksToImpact: Math.max(1, Math.ceil(hit.distance / perTick)),
      category: p.category,
    });
  }
  return found;
}

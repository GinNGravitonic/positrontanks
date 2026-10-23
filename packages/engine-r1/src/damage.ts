/**
 * Applying damage to Bots and destructible Obstacles, and Disabling Bots
 * (spec section 2, Damage; language-r1 section 10.4).
 */

import type { ArmorSide } from "@aumohta/ruleset-data";
import type { DamageSource, TickEvent } from "./events.js";
import type { Point } from "./geometry.js";
import { atan2Deg, normalizeAngle } from "./math.js";
import type { BotState, DisabledCause, ObstacleState } from "./world.js";

/**
 * The side of the Bot that a hit at `point` strikes, from the bearing of the
 * point relative to the Bot's Heading: front within 45° either side of
 * straight ahead (inclusive), rear within 45° of straight behind (inclusive),
 * and right or left in between.
 */
export function struckSide(bot: BotState, point: Point): ArmorSide {
  const bearing = normalizeAngle(atan2Deg(point.x - bot.x, bot.y - point.y) - bot.heading);
  const abs = Math.abs(bearing);
  if (abs <= 45) return "front";
  if (abs >= 135) return "rear";
  return bearing > 0 ? "right" : "left";
}

/**
 * Disables an active Bot: it stops dead, its commands are cleared, and it
 * stays where it is as an indestructible wreck. Does nothing to a Bot that is
 * already Disabled.
 */
export function disableBot(bot: BotState, cause: DisabledCause, tick: number, events: TickEvent[]): void {
  if (bot.status === "disabled") return;
  bot.status = "disabled";
  bot.disabledCause = cause;
  bot.speed = 0;
  bot.turnRate = 0;
  bot.throttle = 0;
  bot.turn = 0;
  events.push({ type: "disabled", tick, bot: bot.id, cause });
}

/**
 * Deals `raw` damage to a Bot at `point`. Armor on the struck side absorbs up
 * to its value per hit. A Bot whose Hit Points reach zero is Disabled. Wrecks
 * take no damage.
 */
export function damageBot(
  bot: BotState,
  raw: number,
  point: Point,
  source: DamageSource,
  tick: number,
  events: TickEvent[],
): void {
  if (bot.status === "disabled" || raw <= 0) return;
  const side = struckSide(bot, point);
  const absorbed = Math.min(raw, bot.spec.armor[side]);
  const dealt = Math.min(raw - absorbed, bot.hitPoints);
  bot.hitPoints -= dealt;
  events.push({
    type: "damage",
    tick,
    target: { kind: "bot", id: bot.id },
    source,
    raw,
    absorbed,
    dealt,
    side,
    point,
    absorber: "chassis",
  });
  if (bot.hitPoints <= 0) {
    bot.hitPoints = 0;
    disableBot(bot, "destroyed", tick, events);
  }
}

/**
 * Deals `raw` damage to a destructible Obstacle. One at zero Hit Points is
 * destroyed; the caller removes it at the end of the Tick. Permanent
 * Obstacles take no damage.
 */
export function damageObstacle(
  o: ObstacleState,
  raw: number,
  point: Point,
  source: DamageSource,
  tick: number,
  events: TickEvent[],
): void {
  if (o.hitPoints === null || o.hitPoints <= 0 || raw <= 0) return;
  const dealt = Math.min(raw, o.hitPoints);
  o.hitPoints -= dealt;
  events.push({
    type: "damage",
    tick,
    target: { kind: "obstacle", id: o.obstacle.id },
    source,
    raw,
    absorbed: 0,
    dealt,
    side: null,
    point,
    absorber: null,
  });
  if (o.hitPoints <= 0) {
    o.hitPoints = 0;
    events.push({ type: "obstacleDestroyed", tick, obstacle: o.obstacle.id });
  }
}

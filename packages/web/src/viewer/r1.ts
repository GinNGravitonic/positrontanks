/**
 * The viewer for engine r1's Replays (frontend spec section 7, Motion).
 *
 * A Replay holds the world at the end of every Tick. Between two Ticks, Bot
 * and Projectile positions are interpolated: a Bot moves straight and turns
 * the short way round, a Projectile launched during the Tick flies from the
 * Bot that fired it. What changes at once in the engine (Hit Points, being
 * Disabled, an Obstacle destroyed) changes halfway through its Tick, which is
 * also when that Tick's events are drawn as effects.
 *
 * A Replay assembled from a live stream starts at the Tick of joining rather
 * than Tick 0; its Ticks are numbered on from there. What happened before
 * comes summarized with the snapshot (EarlierTicks): its destroyed Obstacles
 * stay destroyed, its Disablements keep their real Tick, and its damage
 * counts from just before the first Tick.
 */

import type { BotFrame, EarlierTicks, ImpactEvent, ProjectileFrame, Replay, ReplayTick, TickEvent } from "@positrontanks/engine-r1";
import type { Point } from "@positrontanks/ruleset-data";
import { shapeBounds } from "../draw/geometry.js";
import type { Damage, Disablement, Effect, EngineViewer, Hit, Scene, SceneBot, SceneProjectile, Time, ViewerReplay } from "./scene.js";

/** How long an event's effect lasts, in simulated seconds (at least one Tick). */
export const EFFECT_SECONDS = 0.4;

export const r1Viewer: EngineViewer = { load: (replay, earlier) => loadR1Replay(replay, earlier) };

/** Whether `json` has an r1 Replay's header; its Ticks are trusted as the API sends them. */
function isR1Replay(json: unknown): json is Replay {
  const replay = json as Partial<Record<keyof Replay, unknown>> | null;
  return (
    typeof replay?.ruleset === "string" &&
    typeof replay.tickRate === "number" &&
    typeof replay.map === "object" &&
    replay.map !== null &&
    Array.isArray(replay.entries) &&
    Array.isArray(replay.ticks)
  );
}

/** Whether `json` is an r1 summary of the Ticks before `firstTick`; its entries are trusted as the API sends them. */
function isEarlierTicks(json: unknown, firstTick: number): json is EarlierTicks {
  const earlier = json as Partial<Record<keyof EarlierTicks, unknown>> | null | undefined;
  return (
    earlier?.beforeTick === firstTick &&
    Array.isArray(earlier.obstaclesDestroyed) &&
    Array.isArray(earlier.disabled) &&
    Array.isArray(earlier.damage)
  );
}

const NOTHING_EARLIER: Omit<EarlierTicks, "beforeTick"> = { obstaclesDestroyed: [], disabled: [], damage: [] };

/**
 * Reads an r1 Replay, with `earlierJson` taken as having happened before its
 * first Tick. A summary of the Ticks before some other Tick is ignored.
 */
export function loadR1Replay(json: unknown, earlierJson?: unknown): ViewerReplay {
  if (!isR1Replay(json)) throw new Error("not an r1 Replay");
  const replay = json;
  const ticks = replay.ticks;
  const first = ticks[0];
  const last = ticks.at(-1);
  if (first === undefined || last === undefined) throw new Error("the Replay has no Ticks");
  if (ticks.some((t, i) => t.tick !== first.tick + i)) throw new Error("the Replay's Ticks are not numbered in order");
  const earlier = isEarlierTicks(earlierJson, first.tick) ? earlierJson : NOTHING_EARLIER;

  const entryOf = new Map<number, number>();
  replay.entries.forEach((entry, i) => {
    for (const bot of entry.bots) entryOf.set(bot.id, i);
  });
  const destroyedAt = new Map<string, number>();
  for (const e of earlier.obstaclesDestroyed) destroyedAt.set(e.obstacle, e.tick);
  for (const t of ticks) for (const e of t.events) if (e.type === "obstacleDestroyed") destroyedAt.set(e.obstacle, t.tick);
  const obstacleCenters = new Map(
    replay.map.obstacles.map((o) => {
      const b = shapeBounds(o);
      return [o.id, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }];
    }),
  );
  const effectTicks = Math.max(1, EFFECT_SECONDS * replay.tickRate);

  return {
    rulesetVersion: replay.ruleset,
    tickRate: replay.tickRate,
    map: replay.map,
    entries: replay.entries,
    firstTick: first.tick,
    lastTick: last.tick,
    hits: ticks.flatMap((t) => t.events.flatMap((e) => hitsOf(e, eventTime(t.tick)))),
    damage: [
      ...earlier.damage.map((d): Damage => ({ time: first.tick - 1, target: d.target, dealer: d.dealer, amount: d.dealt })),
      ...ticks.flatMap((t) => t.events.flatMap((e) => damageOf(e, eventTime(t.tick)))),
    ],
    disablements: [
      ...earlier.disabled.map((e): Disablement => ({ time: eventTime(e.tick), bot: e.bot, cause: e.cause })),
      ...ticks.flatMap((t) =>
        t.events.flatMap((e): Disablement[] => (e.type === "disabled" ? [{ time: eventTime(t.tick), bot: e.bot, cause: e.cause }] : [])),
      ),
    ],
    scene(time: Time): Scene {
      const t = Math.min(Math.max(time, first.tick), last.tick);
      const i = Math.floor(t);
      const a = ticks[i - first.tick] ?? last;
      const b = ticks[i + 1 - first.tick] ?? a;
      const f = b === a ? 0 : t - i;
      const destroyed = new Set<string>();
      for (const [id, tick] of destroyedAt) if (t >= eventTime(tick)) destroyed.add(id);
      return {
        time: t,
        bots: interpolateBots(a.bots, b.bots, f, entryOf),
        projectiles: interpolateProjectiles(a, b, f),
        effects: effectsAt(ticks, first.tick, t, effectTicks, obstacleCenters),
        destroyedObstacles: destroyed,
      };
    },
  };
}

/** When a Tick's events happen: halfway through it (the init phase's, at once). */
export function eventTime(tick: number): Time {
  return tick === 0 ? 0 : tick - 0.5;
}

export function lerp(from: number, to: number, f: number): number {
  return from + (to - from) * f;
}

/**
 * The hits an event records: a `damage` event to a Bot, from a weapon or a
 * ram, or an `impact` that struck a Bot (a wreck included). A Bot's damage
 * to itself links it to no one.
 */
export function hitsOf(e: TickEvent, time: Time): Hit[] {
  const hit = (a: number, b: number): Hit[] => (a === b ? [] : [{ time, bots: [a, b] }]);
  if (e.type === "impact") return e.target?.kind === "bot" || e.target?.kind === "wreck" ? hit(e.bot, e.target.id) : [];
  if (e.type !== "damage" || e.target.kind !== "bot") return [];
  if (e.source.kind === "weapon") return hit(e.source.bot, e.target.id);
  const other = e.source.with;
  return other.kind === "bot" || other.kind === "wreck" ? hit(other.id, e.target.id) : [];
}

/**
 * The Hit Points a `damage` event took from a Bot, if any. A shot is dealt
 * by the Bot that fired it, a ram by the other Bot; a ram into a wreck, an
 * Obstacle or the boundary is dealt by no Bot, as the engine counts Foe
 * damage.
 */
export function damageOf(e: TickEvent, time: Time): Damage[] {
  if (e.type !== "damage" || e.target.kind !== "bot" || e.dealt <= 0) return [];
  const dealer = e.source.kind === "weapon" ? e.source.bot : e.source.with.kind === "bot" ? e.source.with.id : null;
  return [{ time, target: e.target.id, dealer, amount: e.dealt }];
}

/** The heading `f` of the way from `from` to `to`, turning the short way round; in [0, 360). */
export function lerpHeading(from: number, to: number, f: number): number {
  const turn = ((((to - from) % 360) + 540) % 360) - 180;
  return (((from + turn * f) % 360) + 360) % 360;
}

/** The Bots `f` of the way from frame `a` to frame `b`, by Bot id. */
export function interpolateBots(a: readonly BotFrame[], b: readonly BotFrame[], f: number, entryOf: ReadonlyMap<number, number>): SceneBot[] {
  const before = new Map(a.map((bot) => [bot.id, bot]));
  return b.map((to) => {
    const from = before.get(to.id) ?? to;
    const now = f >= 0.5 ? to : from;
    return {
      id: to.id,
      entry: entryOf.get(to.id) ?? 0,
      x: lerp(from.x, to.x, f),
      y: lerp(from.y, to.y, f),
      heading: lerpHeading(from.heading, to.heading, f),
      speed: lerp(from.speed, to.speed, f),
      hitPoints: now.hitPoints,
      disabled: now.status === "disabled",
    };
  });
}

/**
 * The Projectiles `f` of the way from Tick `a` to Tick `b`: those in flight
 * at both, between the two; those launched in `b`, from where they were
 * fired. Those that ended in `b` are gone; their impact is drawn instead.
 */
export function interpolateProjectiles(a: ReplayTick, b: ReplayTick, f: number): SceneProjectile[] {
  if (f === 0) return a.projectiles.map(({ id, x, y }) => ({ id, x, y }));
  const before = new Map<number, Point>(a.projectiles.map((p) => [p.id, p]));
  for (const e of b.events) if (e.type === "fired" && e.projectile !== null && !before.has(e.projectile)) before.set(e.projectile, e.from);
  return b.projectiles.flatMap((to: ProjectileFrame) => {
    const from = before.get(to.id);
    return from === undefined ? [] : [{ id: to.id, x: lerp(from.x, to.x, f), y: lerp(from.y, to.y, f) }];
  });
}

/** The effects of every event recent enough at `t` to still show; `ticks` start at Tick `firstTick`. */
function effectsAt(ticks: readonly ReplayTick[], firstTick: number, t: Time, effectTicks: number, obstacleCenters: ReadonlyMap<string, Point>): Effect[] {
  const effects: Effect[] = [];
  const first = Math.max(firstTick, Math.ceil(t + 0.5 - effectTicks));
  const lastShown = Math.min(firstTick + ticks.length - 1, Math.floor(t + 0.5));
  for (let k = first; k <= lastShown; k++) {
    const tick = ticks[k - firstTick];
    if (tick === undefined) continue;
    const age = (t - eventTime(k)) / effectTicks;
    if (age < 0 || age >= 1) continue;
    for (const e of tick.events) {
      const effect = effectOf(e, tick, age, obstacleCenters);
      if (effect !== undefined) effects.push(effect);
    }
  }
  return effects;
}

function effectOf(e: TickEvent, tick: ReplayTick, age: number, obstacleCenters: ReadonlyMap<string, Point>): Effect | undefined {
  switch (e.type) {
    case "fired":
      return { kind: "muzzle", at: e.from, heading: e.absBearing, age };
    case "impact":
      return e.projectile === null ? beamOf(e, tick, age) : { kind: "impact", at: e.point, hit: e.target !== null, age };
    case "collision":
      return e.closingSpeed > 0 ? { kind: "collision", at: e.point, age } : undefined;
    case "disabled": {
      const bot = tick.bots.find((b) => b.id === e.bot);
      return bot === undefined ? undefined : { kind: "explosion", at: { x: bot.x, y: bot.y }, age };
    }
    case "obstacleDestroyed": {
      const at = obstacleCenters.get(e.obstacle);
      return at === undefined ? undefined : { kind: "explosion", at, age };
    }
    case "damage":
      return undefined;
  }
}

/** A beam or melee strike, from where its shot was fired (or its Bot, if no `fired` event says) to where it ended. */
function beamOf(e: ImpactEvent, tick: ReplayTick, age: number): Effect | undefined {
  const fired = tick.events.find((x) => x.type === "fired" && x.bot === e.bot && x.weapon === e.weapon);
  const bot = tick.bots.find((b) => b.id === e.bot);
  const from = fired?.type === "fired" ? fired.from : bot === undefined ? undefined : { x: bot.x, y: bot.y };
  return from === undefined ? undefined : { kind: "beam", from, to: e.point, age };
}

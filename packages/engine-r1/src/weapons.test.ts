import { describe, expect, it } from "vitest";
import { disableBot } from "./damage.js";
import type { DamageEvent, ImpactEvent, TickEvent } from "./events.js";
import { hashWorld } from "./hash.js";
import { armed, armored, bot, discBuild, ruleset, testMap, worldWith } from "./test-fixtures.js";
import { step, type BotCommands } from "./tick.js";
import { canFire, type FireTarget } from "./weapons.js";
import { createWorld, type World } from "./world.js";

const ahead: FireTarget = { kind: "bearing", bearing: 0 };

function fire(world: World, orders: Record<number, Record<string, FireTarget>>, extra: Record<number, BotCommands> = {}) {
  const commands = new Map<number, BotCommands>();
  for (const [id, f] of Object.entries(orders)) commands.set(Number(id), { ...extra[Number(id)], fire: f });
  return step(world, commands);
}

function damage(events: readonly TickEvent[]): DamageEvent[] {
  return events.filter((e): e is DamageEvent => e.type === "damage");
}

function impacts(events: readonly TickEvent[]): ImpactEvent[] {
  return events.filter((e): e is ImpactEvent => e.type === "impact");
}

const wall = {
  id: "wall",
  destructible: false as const,
  shape: "polygon" as const,
  points: [
    { x: 29, y: 48 },
    { x: 31, y: 48 },
    { x: 31, y: 52 },
    { x: 29, y: 52 },
  ],
};

describe("Beam Weapons", () => {
  it("hit the first Bot along the aim at once, reduced by Armor on the struck side", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "laser" }), x: 20, y: 50, heading: 90 },
      { build: armored(discBuild, { left: "plate" }), x: 40, y: 50, heading: 0 },
    ]);
    const events = fire(world, { 1: { gun: ahead } });
    expect(events[0]).toMatchObject({ type: "fired", tick: 1, bot: 1, weapon: "gun", category: "beam", projectile: null });
    const [impact] = impacts(events);
    expect(impact?.target).toEqual({ kind: "bot", id: 2 });
    expect(impact?.point.x).toBeCloseTo(39.5, 9);
    expect(impact?.point.y).toBeCloseTo(50, 9);
    expect(damage(events).map((e) => [e.target, e.side, e.raw, e.absorbed, e.dealt, e.source])).toEqual([
      [{ kind: "bot", id: 2 }, "left", 20, 5, 15, { kind: "weapon", bot: 1, weapon: "gun", category: "beam" }],
    ]);
    expect(bot(world, 2).hitPoints).toBe(85);
  });

  it("stop at the Map boundary or at the end of their range", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "laser" }), x: 20, y: 50, heading: 270 },
      { build: armed(discBuild, { gun: "laser" }), x: 20, y: 70, heading: 90 },
    ]);
    const [toWall, spent] = impacts(fire(world, { 1: { gun: ahead }, 2: { gun: ahead } }));
    expect(toWall?.target).toEqual({ kind: "boundary" });
    expect(toWall?.point.x).toBeCloseTo(0, 9);
    expect(spent?.target).toBeNull();
    expect(spent?.point.x).toBeCloseTo(20.4 + 50, 9);
  });

  it("pass through the Bot that fired them", () => {
    const world = worldWith([
      { build: armed(discBuild, { tail: "turret" }), x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 30, y: 50, heading: 90 },
    ]);
    const events = fire(world, { 1: { tail: ahead } });
    expect(events[0]).toMatchObject({ type: "fired", from: { x: expect.closeTo(19.6, 9) as number } });
    expect(impacts(events)[0]?.target).toEqual({ kind: "bot", id: 2 });
    expect(damage(events).map((e) => [e.target, e.side])).toEqual([[{ kind: "bot", id: 2 }, "rear"]]);
  });

  it("are stopped by wrecks, which take no damage", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "laser" }), x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 25, y: 50, heading: 0 },
      { build: discBuild, x: 30, y: 50, heading: 0 },
    ]);
    disableBot(bot(world, 2), "programHalted", 0, []);
    expect(canFire(world, bot(world, 1), "gun", { kind: "point", x: 30, y: 50 })).toBe(false);
    const events = fire(world, { 1: { gun: ahead } });
    expect(impacts(events)[0]?.target).toEqual({ kind: "wreck", id: 2 });
    expect(damage(events)).toEqual([]);
  });
});

describe("Melee Weapons", () => {
  it("hit only within their short range of the muzzle", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "spike" }), x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 21.5, y: 50, heading: 270 },
    ]);
    const [miss] = impacts(fire(world, { 1: { gun: ahead } }));
    expect(miss?.target).toBeNull();
    expect(miss?.point.x).toBeCloseTo(20.9, 9);

    bot(world, 2).x = 21.3;
    step(world); // reloading
    const events = fire(world, { 1: { gun: ahead } });
    expect(impacts(events)[0]?.point.x).toBeCloseTo(20.8, 9);
    expect(damage(events).map((e) => [e.target, e.side, e.dealt])).toEqual([[{ kind: "bot", id: 2 }, "front", 40]]);
  });
});

describe("Projectile Weapons", () => {
  it("travel over several Ticks and hit the first Bot in their path", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "cannon" }), x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 30, y: 50, heading: 90 },
    ]);
    const first = fire(world, { 1: { gun: ahead } });
    expect(first).toMatchObject([{ type: "fired", category: "projectile", projectile: 1 }]);
    expect(world.projectiles).toHaveLength(1);
    expect(world.projectiles[0]?.x).toBeCloseTo(22.4, 9);

    const later: TickEvent[] = [];
    for (let t = 2; t <= 5; t++) later.push(...step(world));
    expect(impacts(later)).toMatchObject([{ tick: 5, projectile: 1, target: { kind: "bot", id: 2 } }]);
    expect(impacts(later)[0]?.point.x).toBeCloseTo(29.5, 9);
    expect(damage(later).map((e) => [e.target, e.side, e.dealt, e.source.kind])).toEqual([
      [{ kind: "bot", id: 2 }, "rear", 30, "weapon"],
    ]);
    expect(world.projectiles).toEqual([]);
  });

  it("can be dodged, and are spent once they have travelled their range", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "cannon" }), x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 30, y: 50, heading: 0 },
    ]);
    const events = fire(world, { 1: { gun: ahead }, 2: {} }, { 2: { throttle: 1 } });
    for (let t = 2; t <= 20; t++) events.push(...step(world));
    expect(damage(events)).toEqual([]);
    const [spent] = impacts(events);
    expect(spent).toMatchObject({ tick: 20, target: null });
    expect(spent?.point.x).toBeCloseTo(60.4, 9);
    expect(world.projectiles).toEqual([]);
  });

  it("hit Obstacles and the Map boundary", () => {
    const world = worldWith(
      [
        { build: armed(discBuild, { gun: "cannon" }), x: 20, y: 50, heading: 90 },
        { build: armed(discBuild, { gun: "cannon" }), x: 5, y: 20, heading: 270 },
      ],
      testMap({ obstacles: [wall] }),
    );
    const events = fire(world, { 1: { gun: ahead }, 2: { gun: ahead } });
    for (let t = 2; t <= 5; t++) events.push(...step(world));
    expect(impacts(events).map((e) => [e.bot, e.target])).toEqual([
      [2, { kind: "boundary" }],
      [1, { kind: "obstacle", id: "wall" }],
    ]);
    expect(damage(events)).toEqual([]);
  });
});

describe("firing rules", () => {
  it("allows aims within the Firing Arc only, centred on the Slot direction", () => {
    const world = worldWith([{ build: armed(discBuild, { gun: "laser", tail: "turret" }), x: 50, y: 50, heading: 90 }]);
    const b = bot(world, 1);
    expect(canFire(world, b, "gun", { kind: "bearing", bearing: 15 })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "bearing", bearing: -15 })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "bearing", bearing: 15.01 })).toBe(false);
    expect(canFire(world, b, "gun", { kind: "absBearing", bearing: 100 })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "absBearing", bearing: 270 })).toBe(false);
    expect(canFire(world, b, "gun", { kind: "point", x: 60, y: 52 })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "point", x: 50, y: 60 })).toBe(false);
    for (const bearing of [0, 90, 180, -135]) expect(canFire(world, b, "tail", { kind: "bearing", bearing })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "point", x: 50.4, y: 50 })).toBe(false); // the muzzle itself
    expect(() => canFire(world, b, "drive", ahead)).toThrow(RangeError);
  });

  it("needs a clear line of fire to a point, but may aim at an Obstacle", () => {
    const world = worldWith(
      [
        { build: armed(discBuild, { gun: "laser" }), x: 20, y: 50, heading: 90 },
        { build: discBuild, x: 40, y: 50, heading: 0 },
      ],
      testMap({ obstacles: [wall] }),
    );
    const b = bot(world, 1);
    expect(canFire(world, b, "gun", { kind: "point", x: 40, y: 50 })).toBe(false);
    expect(canFire(world, b, "gun", { kind: "point", x: 30, y: 50 })).toBe(true);
    expect(canFire(world, b, "gun", { kind: "point", x: 29, y: 50 })).toBe(true);
    expect(canFire(world, b, "gun", ahead)).toBe(true);
    expect(fire(world, { 1: { gun: { kind: "point", x: 40, y: 50 } } })).toEqual([]);
    expect(b.weapons[0]?.ticksUntilReady).toBe(0);
  });

  it("fires at most once every reloadTicks Ticks", () => {
    const world = worldWith([{ build: armed(discBuild, { gun: "laser", tail: "turret" }), x: 50, y: 50, heading: 90 }]);
    const ticks: [number, string][] = [];
    for (let t = 1; t <= 7; t++) {
      for (const e of fire(world, { 1: { gun: ahead, tail: { kind: "bearing", bearing: 180 } } })) {
        if (e.type === "fired") ticks.push([e.tick, e.weapon]);
      }
      if (t === 1) expect(bot(world, 1).weapons.map((w) => w.ticksUntilReady)).toEqual([2, 0]);
    }
    expect(ticks.filter(([, w]) => w === "gun").map(([t]) => t)).toEqual([1, 4, 7]);
    expect(ticks.filter(([, w]) => w === "tail")).toHaveLength(7);
  });

  it("ignores Disabled Bots and rejects unknown weapons", () => {
    const world = worldWith([{ build: armed(discBuild, { gun: "laser" }), x: 50, y: 50, heading: 90 }]);
    expect(() => fire(world, { 1: { nope: ahead } })).toThrow(RangeError);
    disableBot(bot(world, 1), "programHalted", 0, []);
    expect(canFire(world, bot(world, 1), "gun", ahead)).toBe(false);
    expect(fire(world, { 1: { gun: ahead } })).toEqual([]);
  });
});

describe("damage from weapons", () => {
  it("hits Friends like Foes", () => {
    const world = createWorld({
      ruleset,
      map: testMap(),
      entries: [
        { bots: [{ name: "a", build: armed(discBuild, { gun: "laser" }) }, { name: "friend", build: discBuild }] },
        { bots: [{ name: "foe", build: discBuild }] },
      ],
      seed: 1,
    });
    const poses: [number, number][] = [
      [20, 50],
      [30, 50],
      [40, 50],
    ];
    world.bots.forEach((b, i) => {
      [b.x, b.y] = poses[i] ?? [0, 0];
      b.heading = 90;
    });
    expect(bot(world, 1).entry).toBe(bot(world, 2).entry);
    expect(canFire(world, bot(world, 1), "gun", { kind: "point", x: 40, y: 50 })).toBe(true);
    const events = fire(world, { 1: { gun: { kind: "point", x: 40, y: 50 } } });
    expect(damage(events).map((e) => e.target)).toEqual([{ kind: "bot", id: 2 }]);
  });

  it("caps damage dealt at the remaining Hit Points, and lets Bots Disable each other at once", () => {
    const world = worldWith([
      { build: armed(discBuild, { gun: "laser" }), x: 20, y: 50, heading: 90 },
      { build: armed(discBuild, { gun: "laser" }), x: 30, y: 50, heading: 270 },
    ]);
    bot(world, 1).hitPoints = 5;
    bot(world, 2).hitPoints = 12;
    const events = fire(world, { 1: { gun: ahead }, 2: { gun: ahead } });
    expect(events.filter((e) => e.type === "fired")).toHaveLength(2);
    expect(damage(events).map((e) => [e.target, e.raw, e.dealt])).toEqual([
      [{ kind: "bot", id: 2 }, 20, 12],
      [{ kind: "bot", id: 1 }, 20, 5],
    ]);
    expect(events.filter((e) => e.type === "disabled").map((e) => e.bot)).toEqual([2, 1]);
    expect(world.bots.map((b) => [b.status, b.hitPoints])).toEqual([
      ["disabled", 0],
      ["disabled", 0],
    ]);
  });

  it("destroys destructible Obstacles, which still stop shots for the rest of the Tick", () => {
    const crate = { id: "crate", destructible: true as const, hitPoints: 10, shape: "circle" as const, x: 30, y: 50, radius: 1 };
    const world = worldWith(
      [
        { build: armed(discBuild, { tail: "turret" }), x: 20, y: 50, heading: 90 },
        { build: armed(discBuild, { tail: "turret" }), x: 20, y: 52, heading: 90 },
      ],
      testMap({ obstacles: [crate] }),
    );
    const at = { kind: "point", x: 30, y: 50 } as const;
    const events = fire(world, { 1: { tail: at }, 2: { tail: at } });
    expect(impacts(events).map((e) => e.target)).toEqual([
      { kind: "obstacle", id: "crate" },
      { kind: "obstacle", id: "crate" },
    ]);
    expect(damage(events).map((e) => [e.target, e.dealt, e.side])).toEqual([[{ kind: "obstacle", id: "crate" }, 10, null]]);
    expect(events).toContainEqual({ type: "obstacleDestroyed", tick: 1, obstacle: "crate" });
    expect(world.obstacles).toEqual([]);
    const [through] = impacts(fire(world, { 1: { tail: ahead } }));
    expect(through?.target).toBeNull();
    expect(through?.point.x).toBeCloseTo(19.6 + 50, 9);
  });
});

describe("determinism with weapons", () => {
  it("reaches identical state hashes from identical inputs", () => {
    const play = () => {
      const world = worldWith([
        { build: armed(discBuild, { gun: "cannon", tail: "turret" }), x: 20, y: 50, heading: 80 },
        { build: armed(discBuild, { gun: "cannon", tail: "turret" }), x: 60, y: 45, heading: 260 },
      ]);
      const hashes: string[] = [];
      for (let t = 0; t < 40; t++) {
        const f = { gun: ahead, tail: { kind: "point" as const, x: 40, y: 48 } };
        fire(world, { 1: f, 2: f }, { 1: { throttle: 0.5, turn: 0.1 }, 2: { throttle: 0.3, turn: -0.2 } });
        hashes.push(hashWorld(world));
      }
      return hashes;
    };
    expect(play()).toEqual(play());
  });
});

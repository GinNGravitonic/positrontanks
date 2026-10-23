import { describe, expect, it } from "vitest";
import { disableBot } from "./damage.js";
import type { DamageEvent, TickEvent } from "./events.js";
import { hashWorld } from "./hash.js";
import { armored, bot, boxBuild, discBuild, ruleset, testMap, worldWith } from "./test-fixtures.js";
import { RAM_DAMAGE_PER_JOULE, step, type BotCommands } from "./tick.js";
import { createWorld, type World } from "./world.js";

function run(world: World, ticks: number, commands: Record<number, BotCommands> = {}): TickEvent[] {
  const events: TickEvent[] = [];
  const first = new Map(Object.entries(commands).map(([id, c]) => [Number(id), c]));
  for (let i = 0; i < ticks; i++) events.push(...step(world, i === 0 ? first : new Map()));
  return events;
}

function damage(events: readonly TickEvent[]): DamageEvent[] {
  return events.filter((e): e is DamageEvent => e.type === "damage");
}

/** Ramming damage for a closing speed and reduced mass. */
function ram(speed: number, mass: number): number {
  return RAM_DAMAGE_PER_JOULE * 0.5 * mass * speed * speed;
}

describe("movement", () => {
  it("accelerates towards throttle times top speed and keeps commands until changed", () => {
    const world = worldWith([{ build: discBuild, x: 20, y: 50, heading: 90 }]);
    const b = bot(world, 1);
    step(world, new Map([[1, { throttle: 1 }]]));
    expect(b.speed).toBe(1);
    expect(b.x).toBeCloseTo(20.1, 12);
    expect(b.y).toBe(50);
    run(world, 9);
    expect(b.speed).toBe(10);
    expect(b.x).toBeCloseTo(20 + 0.1 * 55, 9);
    run(world, 5);
    expect(b.speed).toBe(10);
    expect(b.x).toBeCloseTo(25.5 + 5, 9);
    expect(world.tick).toBe(15);
  });

  it("clamps commands to [-1, 1], brakes at throttle 0 and reverses", () => {
    const world = worldWith([{ build: discBuild, x: 50, y: 30, heading: 0 }]);
    const b = bot(world, 1);
    run(world, 20, { 1: { throttle: 5 } });
    expect(b.throttle).toBe(1);
    expect(b.speed).toBe(10);
    run(world, 3, { 1: { throttle: 0 } });
    expect(b.speed).toBe(7);
    run(world, 20, { 1: { throttle: -0.5 } });
    expect(b.speed).toBe(-5);
    const y = b.y;
    step(world);
    expect(b.y).toBeCloseTo(y + 0.5, 12);
  });

  it("turns at turn times the turn rate, wrapping the Heading", () => {
    const world = worldWith([{ build: discBuild, x: 50, y: 30, heading: 10 }]);
    const b = bot(world, 1);
    step(world, new Map([[1, { turn: -1 }]]));
    expect(b.turnRate).toBe(-180);
    expect(b.heading).toBeCloseTo(352, 9);
    run(world, 2, { 1: { turn: 0.5 } });
    expect(b.heading).toBeCloseTo(10, 9);
    expect(() => step(world, new Map([[1, { turn: NaN }]]))).toThrow(RangeError);
  });

  it("applies Terrain and motor modifiers to top speed and acceleration", () => {
    const world = worldWith([
      { build: discBuild, x: 10, y: 70, heading: 90 },
      { build: { ...discBuild, components: { drive: "tracks" } }, x: 10, y: 65, heading: 90 },
    ]);
    run(world, 30, { 1: { throttle: 1 }, 2: { throttle: 1 } });
    // Wheels on sand: 10 * 0.5 (sand) * 0.5 (wheels); accel 10 * 0.5 per s, so 0.5 per Tick.
    expect(bot(world, 1).speed).toBe(2.5);
    // Tracks on sand: 6 * 0.5 * 2.
    expect(bot(world, 2).speed).toBe(6);
  });

  it("does not move a Bot without motors", () => {
    const world = worldWith([{ build: { ...discBuild, components: {} }, x: 50, y: 30, heading: 0 }]);
    run(world, 5, { 1: { throttle: 1, turn: 1 } });
    expect([bot(world, 1).x, bot(world, 1).y, bot(world, 1).heading]).toEqual([50, 30, 0]);
  });
});

describe("collisions", () => {
  it("stops a Bot at the Map boundary and rams it", () => {
    const world = worldWith([{ build: discBuild, x: 99.2, y: 50, heading: 90 }]);
    const b = bot(world, 1);
    b.speed = 5;
    b.throttle = 0.5;
    const events = run(world, 1);
    expect(b.x).toBeLessThanOrEqual(99.5);
    expect(b.x).toBeGreaterThan(99.4);
    expect(b.speed).toBe(0);
    expect(events[0]).toMatchObject({ type: "collision", bot: 1, with: { kind: "boundary" }, point: { x: 100, y: 50 } });
    expect(damage(events)).toEqual([
      expect.objectContaining({ target: { kind: "bot", id: 1 }, side: "front", dealt: ram(5, 50), absorber: "chassis" }),
    ]);
    expect(b.hitPoints).toBe(100 - ram(5, 50));
  });

  it("deals no damage below the minimum ramming speed", () => {
    const world = worldWith([{ build: discBuild, x: 50, y: 0.6, heading: 0 }]);
    const events = run(world, 3, { 1: { throttle: 1 } });
    expect(events.some((e) => e.type === "collision")).toBe(true);
    expect(damage(events)).toEqual([]);
  });

  it("never lets a fast Bot tunnel through a thin wall", () => {
    const wall = {
      id: "wall",
      destructible: false as const,
      shape: "polygon" as const,
      points: [
        { x: 60, y: 0 },
        { x: 60.05, y: 0 },
        { x: 60.05, y: 90 },
        { x: 60, y: 90 },
      ],
    };
    const world = worldWith([{ build: discBuild, x: 50, y: 50, heading: 90 }], testMap({ obstacles: [wall] }));
    bot(world, 1).speed = 10;
    const events = run(world, 20, { 1: { throttle: 1 } });
    expect(bot(world, 1).x).toBeLessThan(59.5);
    expect(events.find((e) => e.type === "collision")).toMatchObject({ with: { kind: "obstacle", id: "wall" } });
  });

  it("turns a Bot in place when its forward move is blocked", () => {
    const world = worldWith([{ build: discBuild, x: 50, y: 0.5, heading: 0 }]);
    const b = bot(world, 1);
    run(world, 1, { 1: { throttle: 1, turn: 1 } });
    expect(b.heading).toBeCloseTo(18, 9);
    expect([b.x, b.y, b.speed]).toEqual([50, 0.5, 0]);
    run(world, 12);
    expect(b.y).toBeGreaterThan(0.5);
  });

  it("damages and destroys a destructible Obstacle, which then stops blocking", () => {
    const crate = { id: "crate", destructible: true as const, hitPoints: 30, shape: "circle" as const, x: 60, y: 50, radius: 1 };
    const world = worldWith([{ build: discBuild, x: 58.2, y: 50, heading: 90 }], testMap({ obstacles: [crate] }));
    const b = bot(world, 1);
    b.speed = 5;
    b.throttle = 0.5;
    const first = run(world, 1);
    expect(damage(first).map((e) => [e.target, e.dealt])).toEqual([
      [{ kind: "bot", id: 1 }, ram(5, 50)],
      [{ kind: "obstacle", id: "crate" }, ram(5, 50)],
    ]);
    expect(world.obstacles[0]?.hitPoints).toBe(30 - ram(5, 50));

    b.speed = 5;
    const second = run(world, 1);
    expect(second).toContainEqual({ type: "obstacleDestroyed", tick: 2, obstacle: "crate" });
    expect(damage(second)[1]?.dealt).toBe(30 - ram(5, 50));
    expect(world.obstacles).toEqual([]);
    run(world, 10);
    expect(b.x).toBeGreaterThan(62);
  });

  it("rams both Bots in a head-on collision, reduced by Armor on the struck side", () => {
    const world = worldWith([
      { build: armored(discBuild, { front: "plate" }), x: 50, y: 50, heading: 90 },
      { build: discBuild, x: 51.8, y: 50, heading: 270 },
    ]);
    const [a, b] = [bot(world, 1), bot(world, 2)];
    for (const x of [a, b]) {
      x.speed = 5;
      x.throttle = 0.5;
    }
    const events = run(world, 1);
    const raw = ram(10, 25);
    expect(damage(events).map((e) => [e.target, e.side, e.raw, e.absorbed, e.dealt, e.source])).toEqual([
      [{ kind: "bot", id: 1 }, "front", raw, 5, raw - 5, { kind: "collision", with: { kind: "bot", id: 2 } }],
      [{ kind: "bot", id: 2 }, "front", raw, 0, raw, { kind: "collision", with: { kind: "bot", id: 1 } }],
    ]);
    expect([a.speed, b.speed]).toEqual([0, 0]);
    expect(b.x - a.x).toBeGreaterThan(1);
  });

  it("resolves the same collision the same way whichever Bot is numbered first", () => {
    const setup = (flip: boolean) => {
      const left = { build: discBuild, x: 50, y: 50, heading: 90 };
      const right = { build: boxBuild, x: 52.5, y: 50.3, heading: 270 };
      const world = worldWith(flip ? [right, left] : [left, right]);
      for (const b of world.bots) {
        b.speed = 6;
        b.throttle = 0.6;
      }
      run(world, 3);
      const disc = world.bots.find((b) => b.spec.chassis.id === "disc");
      const box = world.bots.find((b) => b.spec.chassis.id === "box");
      return [disc?.x, disc?.y, disc?.hitPoints, box?.x, box?.y, box?.hitPoints];
    };
    expect(setup(true)).toEqual(setup(false));
  });

  it("stops only the Bot that runs into the back of a slower one", () => {
    const world = worldWith([
      { build: discBuild, x: 50, y: 50, heading: 90 },
      { build: discBuild, x: 51.2, y: 50, heading: 90 },
    ]);
    const [a, b] = [bot(world, 1), bot(world, 2)];
    a.speed = 8;
    a.throttle = 0.8;
    b.speed = 2;
    b.throttle = 0.2;
    const events = run(world, 1);
    expect(a.speed).toBe(0);
    expect(b.speed).toBe(2);
    expect(b.x).toBeCloseTo(51.4, 9);
    expect(events.filter((e) => e.type === "collision").map((e) => e.bot)).toEqual([1]);
    expect(damage(events).map((e) => [e.target, e.side, e.raw])).toEqual([
      [{ kind: "bot", id: 1 }, "front", ram(6, 25)],
      [{ kind: "bot", id: 2 }, "rear", ram(6, 25)],
    ]);
  });

  it("Disables a Bot at zero Hit Points, leaving an indestructible wreck", () => {
    const world = worldWith([
      { build: discBuild, x: 50, y: 50, heading: 90 },
      { build: discBuild, x: 51.8, y: 50, heading: 270 },
    ]);
    const [a, b] = [bot(world, 1), bot(world, 2)];
    b.hitPoints = 10;
    a.speed = 10;
    a.throttle = 1;
    const events = run(world, 1);
    expect(events).toContainEqual({ type: "disabled", tick: 1, bot: 2, cause: "destroyed" });
    expect(b).toMatchObject({ status: "disabled", hitPoints: 0, speed: 0, throttle: 0 });
    const dealt = damage(events).find((e) => e.target.kind === "bot" && e.target.id === 2)?.dealt;
    expect(dealt).toBe(10);

    // The wreck ignores commands, blocks, and takes no further damage.
    const later = run(world, 20, { 1: { throttle: 1 }, 2: { throttle: 1 } });
    expect(b.x).toBe(51.8);
    expect(later.some((e) => e.type === "collision" && e.with.kind === "wreck" && e.with.id === 2)).toBe(true);
    expect(damage(later).every((e) => e.target.kind === "bot" && e.target.id === 1)).toBe(true);
    expect(a.x).toBeLessThan(51);
  });

  it("halts a Bot through disableBot", () => {
    const world = worldWith([{ build: discBuild, x: 50, y: 50, heading: 90 }]);
    const events: TickEvent[] = [];
    disableBot(bot(world, 1), "programHalted", world.tick, events);
    expect(events).toEqual([{ type: "disabled", tick: 0, bot: 1, cause: "programHalted" }]);
    expect(bot(world, 1).disabledCause).toBe("programHalted");
  });
});

describe("determinism", () => {
  it("reaches identical state hashes from identical inputs", () => {
    const play = () => {
      const world = createWorld({
        ruleset,
        map: testMap({
          obstacles: [{ id: "rock", destructible: true, hitPoints: 40, shape: "circle", x: 50, y: 25, radius: 2 }],
        }),
        entries: [
          { bots: [{ name: "a", build: discBuild }] },
          { bots: [{ name: "b", build: boxBuild }] },
          { bots: [{ name: "c", build: discBuild }, { name: "d", build: armored(boxBuild, { front: "plate" }) }] },
        ],
        seed: 2026,
      });
      const hashes: string[] = [];
      for (let t = 0; t < 300; t++) {
        const commands = new Map<number, BotCommands>();
        for (const b of world.bots) {
          // Steer every Bot at the Bot after it, full speed, with a wobble.
          const target = world.bots[b.id % world.bots.length];
          if (target === undefined) continue;
          const want = (Math.atan2(target.x - b.x, b.y - target.y) * 180) / Math.PI;
          const diff = ((want - b.heading + 540) % 360) - 180;
          commands.set(b.id, { throttle: t % 40 < 30 ? 1 : -0.5, turn: diff / 30 });
        }
        step(world, commands);
        hashes.push(hashWorld(world));
      }
      return hashes;
    };
    const first = play();
    expect(play()).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});

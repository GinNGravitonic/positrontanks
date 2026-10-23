import { describe, expect, it } from "vitest";
import { pointInShape, shapesOverlap } from "./geometry.js";
import { hashWorld } from "./hash.js";
import { discBuild, ruleset, testMap, without } from "./test-fixtures.js";
import { botShape, createWorld, type EntrySetup } from "./world.js";

function entry(prefix: string, count: number): EntrySetup {
  return { bots: Array.from({ length: count }, (_, i) => ({ name: `${prefix}${String(i)}`, build: discBuild })) };
}

describe("createWorld", () => {
  it("places each Entry's Bots inside its Spawn Zone, facing the zone's Heading", () => {
    const map = testMap();
    const world = createWorld({ ruleset, map, entries: [entry("a", 1), entry("b", 3), entry("c", 1)], seed: 7 });
    // The three-Bot Entry only fits the roomy zone.
    expect(world.spawnZones[1]).toBe(2);
    expect(new Set(world.spawnZones).size).toBe(3);
    for (const bot of world.bots) {
      const zone = map.spawnZones[world.spawnZones[bot.entry] ?? -1];
      if (zone === undefined) throw new Error("no zone");
      const zoneShape =
        zone.shape === "circle" ? { shape: "circle" as const, x: zone.x, y: zone.y, radius: zone.radius } : zone;
      expect(pointInShape(bot, zoneShape)).toBe(true);
      expect(bot.heading).toBe(zone.heading);
      expect(bot.hitPoints).toBe(100);
      expect(bot.status).toBe("active");
    }
    expect(world.bots.map((b) => [b.id, b.name, b.entry])).toEqual([
      [1, "a0", 0],
      [2, "b0", 1],
      [3, "b1", 1],
      [4, "b2", 1],
      [5, "c0", 2],
    ]);
    for (const a of world.bots) {
      for (const b of world.bots) if (a !== b) expect(shapesOverlap(botShape(a), botShape(b))).toBe(false);
    }
  });

  it("is a function of the seed", () => {
    const setup = { ruleset, map: testMap(), entries: [entry("a", 2), entry("b", 1)] };
    const a = createWorld({ ...setup, seed: 42 });
    const b = createWorld({ ...setup, seed: 42 });
    const c = createWorld({ ...setup, seed: 43 });
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.bots.map((bot) => [bot.x, bot.y])).toEqual(b.bots.map((bot) => [bot.x, bot.y]));
    expect(hashWorld(a)).not.toBe(hashWorld(c));
  });

  it("keeps Bots clear of Obstacles", () => {
    const map = testMap({
      obstacles: [{ id: "post", destructible: false, shape: "circle", x: 50, y: 40, radius: 8 }],
    });
    // The roomy zone at (50, 40) radius 10 is mostly covered by the post.
    const world = createWorld({ ruleset, map, entries: [entry("a", 4)], seed: 3 });
    for (const bot of world.bots) {
      expect(Math.hypot(bot.x - 50, bot.y - 40)).toBeGreaterThan(8.5);
    }
  });

  it("rejects Entries that no free Spawn Zone can hold", () => {
    expect(() => createWorld({ ruleset, map: testMap(), entries: [entry("a", 3), entry("b", 2)], seed: 1 })).toThrow(
      /no free Spawn Zone can hold Entry 1/,
    );
  });

  it("gives up on a Spawn Zone too small for its Bots", () => {
    const map = testMap();
    const tiny = { ...map, spawnZones: [{ ...map.spawnZones[2], radius: 0.3 }, ...map.spawnZones.slice(0, 2)] } as typeof map;
    expect(() => createWorld({ ruleset, map: tiny, entries: [entry("a", 4)], seed: 1 })).toThrow(/could not place Bot "a1"/);
  });

  it("rejects duplicate Bot Names and a Ruleset engine-r1 cannot run", () => {
    expect(() => createWorld({ ruleset, map: testMap(), entries: [entry("a", 1), entry("a", 1)], seed: 1 })).toThrow(
      /duplicate Bot Name "a0"/,
    );
    const kinds = without(ruleset.componentKinds, "motor");
    expect(() =>
      createWorld({ ruleset: { ...ruleset, componentKinds: kinds }, map: testMap(), entries: [entry("a", 1)], seed: 1 }),
    ).toThrow(/Ruleset unsupported by engine-r1: ruleset.componentKinds.motor is required/);
  });
});

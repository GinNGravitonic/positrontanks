import { describe, expect, it } from "vitest";
import type { MapFormat1 } from "@aumohta/ruleset-data";
import { pointInShape, shapeBounds, shapesOverlap } from "./geometry.js";
import { hashWorld } from "./hash.js";
import { discBuild, ruleset, testMap, without } from "./test-fixtures.js";
import { GOLDEN_GAMES } from "./golden-games.js";
import { botShape, createWorld, obstacleShape, withinMap, type EntrySetup, type World } from "./world.js";

function entry(prefix: string, count: number): EntrySetup {
  return { bots: Array.from({ length: count }, (_, i) => ({ name: `${prefix}${String(i)}`, build: discBuild })) };
}

/** The four-corners golden Map: zone capacities 3, 3, 3 and 2. */
function fourCorners(): MapFormat1 {
  const game = GOLDEN_GAMES.find((g) => g.name === "four-corners-time-limit");
  if (game === undefined) throw new Error("no four-corners golden");
  return game.map;
}

/**
 * Every Bot lies within the Map, clear of Obstacles and other Bots, and any
 * Bot outside its own Spawn Zone clear of every other zone too.
 */
function expectSpawnedApart(world: World, map: MapFormat1): void {
  const zoneShapes = map.spawnZones.map((z) =>
    z.shape === "circle" ? { shape: "circle" as const, x: z.x, y: z.y, radius: z.radius } : z,
  );
  for (const a of world.bots) {
    const shape = botShape(a);
    expect(withinMap(map, shapeBounds(shape))).toBe(true);
    for (const o of map.obstacles) expect(shapesOverlap(shape, obstacleShape(o))).toBe(false);
    for (const b of world.bots) if (a !== b) expect(shapesOverlap(shape, botShape(b))).toBe(false);
    const own = world.spawnZones[a.entry] ?? -1;
    const ownZone = zoneShapes[own];
    if (ownZone === undefined) throw new Error("no zone");
    if (!pointInShape(a, ownZone)) {
      zoneShapes.forEach((z, i) => {
        if (i !== own) expect(shapesOverlap(shape, z)).toBe(false);
      });
    }
  }
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

  it("gives an Entry no free Spawn Zone can hold the largest free zone and spills its overflow", () => {
    const map = testMap();
    const seen = new Set<number>();
    for (let seed = 0; seed < 20; seed++) {
      const world = createWorld({ ruleset, map, entries: [entry("a", 3), entry("b", 2)], seed });
      expect(world.spawnZones[0]).toBe(2);
      const zone = world.spawnZones[1] ?? -1;
      // The two single-Bot zones tie as the largest free zone; the seed decides.
      expect([0, 1]).toContain(zone);
      seen.add(zone);
      expectSpawnedApart(world, map);
    }
    expect(seen.size).toBe(2);
  });

  it("starts four 3-Bot Entries on four-corners, spilling the one in the 2-Bot zone", () => {
    const map = fourCorners();
    for (let seed = 0; seed < 20; seed++) {
      const world = createWorld({ ruleset, map, entries: [entry("a", 3), entry("b", 3), entry("c", 3), entry("d", 3)], seed });
      expect([...world.spawnZones].sort()).toEqual([0, 1, 2, 3]);
      expectSpawnedApart(world, map);
      const small = world.spawnZones.indexOf(3);
      const [first, second, overflow] = world.bots.filter((b) => b.entry === small);
      if (first === undefined || second === undefined || overflow === undefined) throw new Error("missing Bot");
      expect(Math.hypot(first.x - 10, first.y - 70)).toBeLessThanOrEqual(5);
      expect(Math.hypot(second.x - 10, second.y - 70)).toBeLessThanOrEqual(5);
      // The overflow Bot takes the first free spot on the rings round the zone's centre.
      expect(overflow.heading).toBe(45);
      expect(Math.hypot(overflow.x - 10, overflow.y - 70)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  it("places spilled Bots deterministically per seed", () => {
    const setup = { ruleset, map: fourCorners(), entries: [entry("a", 3), entry("b", 3), entry("c", 3), entry("d", 3)] };
    const a = createWorld({ ...setup, seed: 5 });
    const b = createWorld({ ...setup, seed: 5 });
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.bots.map((bot) => [bot.x, bot.y])).toEqual(b.bots.map((bot) => [bot.x, bot.y]));
  });

  it("places Bots within capacity as if nothing spilled, drawing nothing for overflow", () => {
    const map = testMap();
    const zones = [map.spawnZones[0], map.spawnZones[1]] as typeof map.spawnZones;
    const fits = createWorld({ ruleset, map: { ...map, spawnZones: zones }, entries: [entry("a", 1), entry("b", 1)], seed: 9 });
    const spills = createWorld({ ruleset, map: { ...map, spawnZones: zones }, entries: [entry("a", 2), entry("b", 1)], seed: 9 });
    const [a0, , b0] = spills.bots;
    expect([a0?.x, a0?.y]).toEqual([fits.bots[0]?.x, fits.bots[0]?.y]);
    expect([b0?.x, b0?.y]).toEqual([fits.bots[1]?.x, fits.bots[1]?.y]);
  });

  it("falls back to the spill search when the random tries all fail", () => {
    const map = testMap();
    const tiny = { ...map, spawnZones: [{ ...map.spawnZones[2], radius: 0.3 }, ...map.spawnZones.slice(0, 2)] } as typeof map;
    const world = createWorld({ ruleset, map: tiny, entries: [entry("a", 4)], seed: 1 });
    expectSpawnedApart(world, tiny);
    for (const bot of world.bots) expect(Math.hypot(bot.x - 50, bot.y - 40)).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(createWorld({ ruleset, map: tiny, entries: [entry("a", 4)], seed: 1 }).bots).toEqual(world.bots);
  });

  it("gives up only when the spill search exhausts the Map", () => {
    const map = testMap({
      width: 1.5,
      height: 1.5,
      terrainRegions: [],
      spawnZones: [{ shape: "circle", x: 0.75, y: 0.75, radius: 0.25, heading: 0, capacity: 1 }],
    });
    expect(() => createWorld({ ruleset, map, entries: [entry("a", 2)], seed: 1 })).toThrow(/could not place Bot "a1"/);
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

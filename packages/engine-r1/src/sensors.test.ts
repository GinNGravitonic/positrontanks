import type { Build } from "@positrontanks/ruleset-data";
import { describe, expect, it } from "vitest";
import { disableBot } from "./damage.js";
import { incoming, rangefind, scan } from "./sensors.js";
import { armed, bot, discBuild, ruleset, testMap, worldWith } from "./test-fixtures.js";
import { step } from "./tick.js";
import { createWorld } from "./world.js";

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

const radarBuild = armed(discBuild, { eye: "radar" });
const lidarBuild = armed(discBuild, { eye: "lidar" });
const detectorBuild = armed(discBuild, { eye: "detector" });

function names(contacts: readonly { readonly name: string }[]): string[] {
  return contacts.map((c) => c.name);
}

describe("Radar", () => {
  it("reports Bots whose centre is within its range and arc, measured from the Bot's centre", () => {
    const world = worldWith([
      { build: radarBuild, x: 20, y: 50, heading: 90 },
      { build: discBuild, x: 40, y: 50, heading: 180 }, // ahead, 20 m away
      { build: discBuild, x: 20, y: 30, heading: 0 }, // 90° left, outside the 90° arc
      { build: discBuild, x: 50.01, y: 50, heading: 0 }, // ahead, just out of the 30 m range
      { build: discBuild, x: 34, y: 63.9, heading: 0 }, // 44.8° right, just inside the arc
      { build: discBuild, x: 30, y: 40, heading: 0 }, // 45° left, on the edge of the arc
    ]);
    const contacts = scan(world, bot(world, 1));
    expect(names(contacts)).toEqual(["bot2", "bot5", "bot6"]);
    expect(contacts[0]).toEqual({
      id: 2,
      name: "bot2",
      x: 40,
      y: 50,
      distance: 20,
      bearing: 0,
      absBearing: 90,
      heading: 180,
      speed: 0,
      isFoe: true,
    });
  });

  it("is blocked by Obstacles and wrecks but not by Bots", () => {
    const world = worldWith(
      [
        { build: radarBuild, x: 20, y: 50, heading: 90 },
        { build: discBuild, x: 40, y: 50, heading: 0 },
        { build: discBuild, x: 20, y: 40, heading: 0 },
        { build: discBuild, x: 20, y: 45, heading: 0 },
      ],
      testMap({ obstacles: [wall] }),
    );
    // Bot 4 stands between the Radar and Bot 3, and blocks nothing.
    bot(world, 1).heading = 0;
    expect(names(scan(world, bot(world, 1)))).toEqual(["bot3", "bot4"]);
    disableBot(bot(world, 4), "destroyed", 0, []);
    expect(names(scan(world, bot(world, 1)))).toEqual([]);
    bot(world, 1).heading = 90;
    expect(names(scan(world, bot(world, 1)))).toEqual([]); // the wall hides Bot 2
  });

  it("merges several Radars without duplicates, and sees nothing without one", () => {
    const both: Build = armed(discBuild, { eye: "allSeeing", ear: "allSeeing" });
    const world = worldWith([
      { build: both, x: 20, y: 50, heading: 0 },
      { build: discBuild, x: 60, y: 90, heading: 0 },
      { build: discBuild, x: 10, y: 10, heading: 0 },
    ]);
    expect(names(scan(world, bot(world, 1)))).toEqual(["bot2", "bot3"]);
    expect(scan(world, bot(world, 2))).toEqual([]);
  });

  it("tells Friends from Foes", () => {
    const seer = armed(discBuild, { eye: "allSeeing" });
    const world = createWorld({
      ruleset,
      map: testMap(),
      entries: [{ bots: [{ name: "a", build: seer }, { name: "b", build: discBuild }] }, { bots: [{ name: "c", build: discBuild }] }],
      seed: 3,
    });
    expect(scan(world, bot(world, 1)).map((c) => [c.name, c.isFoe])).toEqual([
      ["b", false],
      ["c", true],
    ]);
  });
});

describe("Rangefinder", () => {
  it("measures from the Bot's centre to the first Bot, Obstacle, wreck or boundary along the Slot direction", () => {
    const world = worldWith(
      [
        { build: lidarBuild, x: 20, y: 50, heading: 90 },
        { build: discBuild, x: 25, y: 50, heading: 0 },
      ],
      testMap({ obstacles: [wall] }),
    );
    const finder = bot(world, 1);
    const reading = () => {
      const r = rangefind(world, finder, "eye");
      return r === null ? null : [r.hit, Number(r.distance.toFixed(9))];
    };
    expect(reading()).toEqual(["bot", 4.5]);
    disableBot(bot(world, 2), "destroyed", 0, []);
    expect(reading()).toEqual(["obstacle", 4.5]); // a wreck
    bot(world, 2).x = 90;
    expect(reading()).toEqual(["obstacle", 9]);
    finder.x = 95;
    expect(reading()).toEqual(["boundary", 5]);
    finder.x = 50;
    expect(rangefind(world, finder, "eye")).toBeNull(); // nothing within 20 m
    // A Rangefinder in a rear Slot looks backwards, still from the centre.
    const rear = worldWith([{ build: armed(discBuild, { ear: "lidar" }), x: 95, y: 50, heading: 270 }]);
    expect(rangefind(rear, bot(rear, 1), "ear")).toEqual({ distance: 5, hit: "boundary" });
  });

  it("must be a Rangefinder the Bot has", () => {
    const world = worldWith([{ build: radarBuild, x: 20, y: 50, heading: 90 }]);
    expect(() => rangefind(world, bot(world, 1), "eye")).toThrow(/no rangefinder "eye"/);
    expect(() => rangefind(world, bot(world, 1), "gun")).toThrow(/no rangefinder "gun"/);
  });
});

describe("Projectile Detector", () => {
  const cannon = armed(discBuild, { gun: "cannon" });

  /** Bot 1 at (20, 50) fires its cannon east; the Projectile ends the Tick at (22, 50). */
  function shoot(targets: readonly { build: Build; x: number; y: number }[]) {
    const world = worldWith([{ build: cannon, x: 20, y: 50, heading: 90 }, ...targets.map((t) => ({ ...t, heading: 0 }))]);
    step(world, new Map([[1, { fire: { gun: { kind: "bearing", bearing: 0 } } }]]));
    expect(world.projectiles).toHaveLength(1);
    return world;
  }

  it("reports Projectiles on a collision course with the Tick they would hit in", () => {
    const world = shoot([{ build: detectorBuild, x: 40, y: 50 }]);
    // 17.5 m to the Bot's outline at 2 m per Tick: it hits in the 9th Tick from now.
    expect(incoming(world, bot(world, 2))).toEqual([{ bearing: -90, ticksToImpact: 9, category: "projectile" }]);
    for (let i = 0; i < 8; i++) step(world);
    expect(incoming(world, bot(world, 2))).toEqual([{ bearing: -90, ticksToImpact: 1, category: "projectile" }]);
    step(world);
    expect(world.projectiles).toHaveLength(0);
    expect(bot(world, 2).hitPoints).toBe(70);
  });

  it("ignores Projectiles that would miss, hit something else first, or be spent first", () => {
    const miss = shoot([{ build: detectorBuild, x: 40, y: 51 }]);
    expect(incoming(miss, bot(miss, 2))).toEqual([]);
    const shielded = shoot([
      { build: detectorBuild, x: 40, y: 50 },
      { build: detectorBuild, x: 30, y: 50 },
    ]);
    expect(incoming(shielded, bot(shielded, 2))).toEqual([]);
    expect(incoming(shielded, bot(shielded, 3))).toHaveLength(1);
    const far = shoot([{ build: detectorBuild, x: 70, y: 50 }]);
    expect(incoming(far, bot(far, 2))).toEqual([]);
  });

  it("detects nothing without a detector, and never its own Bot's Projectiles", () => {
    const world = shoot([{ build: discBuild, x: 40, y: 50 }]);
    expect(incoming(world, bot(world, 2))).toEqual([]);
    const own = worldWith([{ build: armed(cannon, { eye: "detector" }), x: 20, y: 50, heading: 90 }]);
    step(own, new Map([[1, { fire: { gun: { kind: "bearing", bearing: 0 } } }]]));
    expect(incoming(own, bot(own, 1))).toEqual([]);
  });
});

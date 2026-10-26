/**
 * A small Ruleset and Map for engine tests. Not r1's real numbers.
 */

import type { Build, Component, MapFormat1, Ruleset } from "@aumohta/ruleset-data";
import { createWorld, type BotState, type EntrySetup, type World } from "./world.js";

const noArmor = { front: null, left: null, right: null, rear: null } as const;

function weapon(id: string, stats: Component["stats"]): Component {
  return { id, name: id, description: id, kind: "weapon", cost: 5, slotTypes: ["weapon"], stats };
}

function sensor(id: string, stats: Component["stats"]): Component {
  return { id, name: id, description: id, kind: "sensor", cost: 5, slotTypes: ["sensor"], stats };
}

export const ruleset: Ruleset = {
  version: "test",
  tickRate: 10,
  pointBudget: { min: 10, max: 1000 },
  mapFormats: [1],
  terrains: [
    { name: "grass", description: "grass", speed: 1, accel: 1 },
    { name: "sand", description: "sand", speed: 0.5, accel: 0.5 },
    { name: "road", description: "road", speed: 1.2, accel: 1 },
  ],
  limits: {
    initBudgetMultiplier: 20,
    memoryCells: 10000,
    maxCallDepth: 64,
    maxCollectionLength: 10000,
    maxSourceBytes: 65536,
    logLinesPerTick: 50,
    logLineLength: 200,
  },
  slotTypes: ["motor", "weapon", "sensor", "utility"],
  chassisStats: {
    mass: { type: "number", min: 1 },
    hitPoints: { type: "number", min: 1, integer: true },
    operationBudget: { type: "number", min: 1, integer: true },
  },
  componentKinds: {
    motor: {
      mount: "slot",
      stats: {
        force: { type: "number", min: 0 },
        maxSpeed: { type: "number", min: 0 },
        turnRate: { type: "number", min: 0 },
        mass: { type: "number", min: 0 },
        motorTerrain: { type: "terrainModifiers" },
      },
    },
    armor: { mount: "side", stats: { armor: { type: "number", min: 0 }, mass: { type: "number", min: 0 } } },
    weapon: {
      mount: "slot",
      stats: {
        category: { type: "enum", values: ["melee", "projectile", "beam"] },
        arcWidth: { type: "number", min: 0, max: 360 },
        range: { type: "number", min: 0 },
        reloadTicks: { type: "number", min: 1, integer: true },
        damage: { type: "number", min: 0 },
        projectileSpeed: { type: "number", min: 0 },
      },
    },
    sensor: {
      mount: "slot",
      stats: {
        kind: { type: "enum", values: ["radar", "rangefinder", "projectileDetector"] },
        arcWidth: { type: "number", min: 0, max: 360 },
        range: { type: "number", min: 0 },
      },
    },
    processor: { mount: "slot", stats: { operationBudget: { type: "number", min: 1, integer: true } } },
  },
  chassis: [
    {
      id: "disc",
      name: "Disc",
      description: "Disc",
      cost: 10,
      shape: { shape: "circle", radius: 0.5 },
      slots: [
        { id: "drive", type: "motor", x: 0, y: 0, direction: 0 },
        { id: "drive2", type: "motor", x: 0, y: 0.2, direction: 180 },
        { id: "gun", type: "weapon", x: 0, y: -0.4, direction: 0 },
        { id: "tail", type: "weapon", x: 0, y: 0.4, direction: 180 },
        { id: "eye", type: "sensor", x: 0, y: -0.3, direction: 0 },
        { id: "ear", type: "sensor", x: 0, y: 0.3, direction: 180 },
        { id: "bay", type: "utility", x: 0, y: 0, direction: 0 },
      ],
      stats: { mass: 50, hitPoints: 100, operationBudget: 1000 },
    },
    {
      id: "box",
      name: "Box",
      description: "Box",
      cost: 20,
      shape: {
        shape: "polygon",
        points: [
          { x: -0.5, y: -1 },
          { x: 0.5, y: -1 },
          { x: 0.5, y: 1 },
          { x: -0.5, y: 1 },
        ],
      },
      slots: [
        { id: "drive", type: "motor", x: 0, y: 0, direction: 0 },
        { id: "gun", type: "weapon", x: 0, y: -0.9, direction: 0 },
      ],
      stats: { mass: 100, hitPoints: 200, operationBudget: 1000 },
    },
  ],
  components: [
    {
      id: "wheels",
      name: "Wheels",
      description: "Wheels",
      kind: "motor",
      cost: 5,
      slotTypes: ["motor"],
      stats: { force: 500, maxSpeed: 10, turnRate: 180, mass: 0, motorTerrain: { sand: { speed: 0.5, accel: 1 } } },
    },
    {
      id: "tracks",
      name: "Tracks",
      description: "Tracks",
      kind: "motor",
      cost: 5,
      slotTypes: ["motor"],
      stats: { force: 300, maxSpeed: 6, turnRate: 90, mass: 10, motorTerrain: { sand: { speed: 2, accel: 2 } } },
    },
    { id: "plate", name: "Plate", description: "Plate", kind: "armor", cost: 5, slotTypes: [], stats: { armor: 5, mass: 0 } },
    weapon("spike", { category: "melee", arcWidth: 60, range: 1, reloadTicks: 2, damage: 40, projectileSpeed: 0 }),
    weapon("laser", { category: "beam", arcWidth: 30, range: 50, reloadTicks: 3, damage: 20, projectileSpeed: 0 }),
    weapon("turret", { category: "beam", arcWidth: 360, range: 50, reloadTicks: 1, damage: 10, projectileSpeed: 0 }),
    weapon("cannon", { category: "projectile", arcWidth: 20, range: 40, reloadTicks: 5, damage: 30, projectileSpeed: 20 }),
    sensor("radar", { kind: "radar", arcWidth: 90, range: 30 }),
    sensor("allSeeing", { kind: "radar", arcWidth: 360, range: 200 }),
    sensor("lidar", { kind: "rangefinder", arcWidth: 0, range: 20 }),
    sensor("detector", { kind: "projectileDetector", arcWidth: 360, range: 50 }),
    { id: "cpu", name: "CPU", description: "CPU", kind: "processor", cost: 5, slotTypes: ["utility"], stats: { operationBudget: 3000 } },
  ],
};

/** A Disc on Wheels: 50 kg, accel 10 m/s², top speed 10 m/s, turn 180°/s. */
export const discBuild: Build = { chassis: "disc", components: { drive: "wheels" }, armor: noArmor };

export const boxBuild: Build = { chassis: "box", components: { drive: "wheels" }, armor: noArmor };

/** A copy of the record without `key`. */
export function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** The Build with these Components added, by Slot. */
export function armed(build: Build, components: Readonly<Record<string, string>>): Build {
  return { ...build, components: { ...build.components, ...components } };
}

export function armored(build: Build, armor: Partial<Build["armor"]>): Build {
  return { ...build, armor: { ...build.armor, ...armor } };
}

/** 100 x 100 grass with a sand strip, two small Spawn Zones and a third roomy one. */
export function testMap(extra: Partial<MapFormat1> = {}): MapFormat1 {
  return {
    format: 1,
    width: 100,
    height: 100,
    baseTerrain: "grass",
    terrainRegions: [
      {
        terrain: "sand",
        shape: "polygon",
        points: [
          { x: 0, y: 60 },
          { x: 100, y: 60 },
          { x: 100, y: 80 },
          { x: 0, y: 80 },
        ],
      },
    ],
    obstacles: [],
    spawnZones: [
      { shape: "circle", x: 10, y: 10, radius: 3, heading: 90, capacity: 1 },
      { shape: "circle", x: 90, y: 10, radius: 3, heading: 270, capacity: 1 },
      { shape: "circle", x: 50, y: 40, radius: 10, heading: 0, capacity: 4 },
    ],
    ...extra,
  };
}

/** A world with one single-Bot Entry per Build, each Bot then moved to the given pose. */
export function worldWith(
  bots: readonly { build: Build; x: number; y: number; heading: number }[],
  map: MapFormat1 = testMap(),
): World {
  const entries: EntrySetup[] = bots.map((b, i) => ({ bots: [{ name: `bot${String(i + 1)}`, build: b.build }] }));
  const zones = bots.map((_, i) => ({ shape: "circle" as const, x: 5 + i * 3, y: 95, radius: 1, heading: 0, capacity: 1 }));
  const world = createWorld({ ruleset, map: { ...map, spawnZones: zones }, entries, seed: 1 });
  bots.forEach((b, i) => {
    const bot = world.bots[i];
    if (bot === undefined) throw new Error("missing Bot");
    bot.x = b.x;
    bot.y = b.y;
    bot.heading = b.heading;
  });
  return world;
}

export function bot(world: World, id: number): BotState {
  const b = world.bots[id - 1];
  if (b === undefined) throw new Error(`no Bot ${String(id)}`);
  return b;
}

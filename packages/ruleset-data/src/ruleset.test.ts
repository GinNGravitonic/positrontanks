import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkMapTerrains, parseMap } from "./map-format-1.js";
import {
  parseRuleset,
  terrainNames,
  validateBuild,
  validateRuleset,
  type Ruleset,
  type RulesetError,
} from "./ruleset.js";

const sampleJson = readFileSync(new URL("../rulesets/sample.json", import.meta.url), "utf8");

function sample(): Record<string, unknown> {
  return JSON.parse(sampleJson) as Record<string, unknown>;
}

function loaded(): Ruleset {
  const result = parseRuleset(sampleJson);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.ruleset;
}

/** The sample with each [path, value] change applied; an undefined value deletes the field. */
function edited(...changes: [string, unknown][]): Record<string, unknown> {
  const root = sample();
  for (const [path, value] of changes) {
    const keys = path.split(".");
    const last = keys.pop() ?? "";
    let target: unknown = root;
    for (const key of keys) target = (target as Record<string, unknown>)[key];
    const obj = target as Record<string, unknown>;
    if (value === undefined) Reflect.deleteProperty(obj, last);
    else obj[last] = value;
  }
  return root;
}

function errorsOf(input: unknown): readonly RulesetError[] {
  const result = validateRuleset(input);
  return result.ok ? [] : result.errors;
}

/** The error paths after applying one change to the sample. */
function pathsAfter(path: string, value: unknown): string[] {
  return errorsOf(edited([path, value])).map((e) => e.path);
}

describe("validateRuleset", () => {
  it("loads the sample Ruleset", () => {
    const ruleset = loaded();
    expect(ruleset.version).toBe("sample");
    expect(ruleset.terrains.map((t) => t.name)).toEqual(["grass", "road", "sand"]);
    expect(ruleset.chassis).toHaveLength(2);
    expect(ruleset.components).toHaveLength(7);
    expect(ruleset.limits.memoryCells).toBe(10000);
    expect(ruleset.chassis[1]?.artwork).toBe("art/brawler.svg");
    expect(ruleset.components[3]?.stats.motorTerrain).toEqual({ road: { speed: 1.2, accel: 1 } });
  });

  it("rejects non-objects and bad JSON", () => {
    expect(errorsOf(null)).toEqual([{ path: "ruleset", message: "must be an object" }]);
    expect(parseRuleset("{").ok).toBe(false);
  });

  it("reports missing and unknown root fields", () => {
    const paths = errorsOf(edited(["tickRate", undefined], ["extra", 1])).map((e) => e.path);
    expect(paths).toEqual(["ruleset.extra", "ruleset.tickRate"]);
  });

  it("checks scalar rules", () => {
    expect(pathsAfter("tickRate", 0)).toEqual(["ruleset.tickRate"]);
    expect(pathsAfter("pointBudget", { min: 500, max: 100 })).toEqual(["ruleset.pointBudget"]);
    expect(pathsAfter("mapFormats", [2])).toEqual(["ruleset.mapFormats[0]"]);
    expect(pathsAfter("mapFormats", [1, 1])).toEqual(["ruleset.mapFormats[1]"]);
    expect(pathsAfter("mapFormats", [])).toEqual(["ruleset.mapFormats"]);
    expect(pathsAfter("limits.maxCallDepth", 1.5)).toEqual(["ruleset.limits.maxCallDepth"]);
    expect(pathsAfter("limits.memoryCells", undefined)).toEqual(["ruleset.limits.memoryCells"]);
  });

  it("requires a Point Budget range that fits the cheapest Chassis", () => {
    expect(pathsAfter("pointBudget.min", 59)).toEqual(["ruleset.pointBudget.min"]);
  });

  it("checks Terrains", () => {
    expect(pathsAfter("terrains", [])).toEqual(["ruleset.terrains"]);
    expect(pathsAfter("terrains.1.name", "grass")).toEqual(["ruleset.terrains[1].name"]);
    expect(pathsAfter("terrains.0.name", "1st")).toEqual(["ruleset.terrains[0].name"]);
    expect(pathsAfter("terrains.2.speed", 0)).toEqual(["ruleset.terrains[2].speed"]);
    expect(pathsAfter("terrains.2.depth", 1)).toEqual(["ruleset.terrains[2].depth"]);
  });

  it("checks stat definitions", () => {
    expect(pathsAfter("chassisStats.mass", { type: "vector" })).toEqual(["ruleset.chassisStats.mass.type"]);
    expect(pathsAfter("chassisStats.mass", { type: "number", min: 5, max: 1 })).toEqual(["ruleset.chassisStats.mass"]);
    expect(pathsAfter("componentKinds.weapon.stats.category.values", [])).toEqual([
      "ruleset.componentKinds.weapon.stats.category.values",
    ]);
    expect(pathsAfter("componentKinds.armor.mount", "hull")).toEqual(["ruleset.componentKinds.armor.mount"]);
  });

  it("checks stats against their declarations", () => {
    expect(pathsAfter("chassis.0.stats.hitPoints", 60.5)).toEqual(["ruleset.chassis[0].stats.hitPoints"]);
    expect(pathsAfter("chassis.0.stats.mass", undefined)).toEqual(["ruleset.chassis[0].stats.mass"]);
    expect(pathsAfter("chassis.0.stats.mass", 0)).toEqual(["ruleset.chassis[0].stats.mass"]);
    expect(pathsAfter("chassis.0.stats.heatLimit", 10)).toEqual(["ruleset.chassis[0].stats.heatLimit"]);
    expect(pathsAfter("components.0.stats.category", "laser")).toEqual(["ruleset.components[0].stats.category"]);
    expect(pathsAfter("components.3.stats.motorTerrain", { swamp: { speed: 1, accel: 1 } })).toEqual([
      "ruleset.components[3].stats.motorTerrain.swamp",
    ]);
    expect(pathsAfter("components.3.stats.motorTerrain", 2)).toEqual(["ruleset.components[3].stats.motorTerrain"]);
    expect(pathsAfter("components.3.stats.motorTerrain", JSON.parse('{"__proto__": {"speed": 1, "accel": 1}}'))).toEqual([
      "ruleset.components[3].stats.motorTerrain.__proto__",
    ]);
  });

  it("accepts a new stat once it is declared (ADR-0004)", () => {
    const result = validateRuleset(
      edited(
        ["chassisStats.heatLimit", { type: "number", min: 0 }],
        ["chassis.0.stats.heatLimit", 100],
        ["chassis.1.stats.heatLimit", 150],
      ),
    );
    expect(result.ok && result.ruleset.chassis[0]?.stats.heatLimit).toBe(100);
  });

  it("checks Chassis", () => {
    expect(pathsAfter("chassis", [])).toEqual(["ruleset.chassis"]);
    expect(pathsAfter("chassis.0.cost", 0)).toEqual(["ruleset.chassis[0].cost"]);
    expect(pathsAfter("chassis.1.id", "scout")).toEqual(["ruleset.chassis[1].id"]);
    expect(pathsAfter("chassis.0.artwork", "")).toEqual(["ruleset.chassis[0].artwork"]);
    expect(pathsAfter("chassis.0.shape", { shape: "circle", radius: 1, x: 2 })).toEqual(["ruleset.chassis[0].shape.x"]);
    const offCentre = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ];
    expect(pathsAfter("chassis.1.shape.points", offCentre)).toEqual(["ruleset.chassis[1].shape.points"]);
  });

  it("checks Slots", () => {
    expect(pathsAfter("chassis.0.slots.1.id", "gun")).toEqual(["ruleset.chassis[0].slots[1].id"]);
    expect(pathsAfter("chassis.0.slots.0.type", "turret")).toEqual(["ruleset.chassis[0].slots[0].type"]);
    expect(pathsAfter("chassis.0.slots.0.direction", -180)).toEqual(["ruleset.chassis[0].slots[0].direction"]);
    expect(pathsAfter("chassis.0.slots.0.direction", 180)).toEqual([]);
    expect(pathsAfter("chassis.0.slots.0.y", -0.6)).toEqual(["ruleset.chassis[0].slots[0]"]);
  });

  it("checks Components", () => {
    expect(pathsAfter("components.0.id", "scout")).toEqual(["ruleset.components[0].id"]);
    expect(pathsAfter("components.0.kind", "laser")).toEqual(["ruleset.components[0].kind"]);
    expect(pathsAfter("components.0.cost", -1)).toEqual(["ruleset.components[0].cost"]);
    expect(pathsAfter("components.0.slotTypes", ["turret"])).toEqual(["ruleset.components[0].slotTypes[0]"]);
    expect(pathsAfter("components.0.slotTypes", undefined)).toEqual(["ruleset.components[0].slotTypes"]);
    expect(pathsAfter("components.6.slotTypes", ["utility"])).toEqual(["ruleset.components[6].slotTypes"]);
  });

  it("reports every problem at once", () => {
    const errors = errorsOf(edited(["tickRate", -1], ["terrains.0.accel", "fast"], ["components.1.name", ""]));
    expect(errors.map((e) => e.path)).toEqual([
      "ruleset.tickRate",
      "ruleset.terrains[0].accel",
      "ruleset.components[1].name",
    ]);
  });

  it("supplies Terrain names for Map checks", () => {
    const map = parseMap(readFileSync(new URL("../maps/duel.json", import.meta.url), "utf8"));
    if (!map.ok) throw new Error("duel.json is invalid");
    const names = terrainNames(loaded());
    expect([...names]).toEqual(["grass", "road", "sand"]);
    expect(checkMapTerrains(map.map, names)).toEqual(checkMapTerrains(map.map, new Set(names)));
  });
});

describe("validateBuild", () => {
  const ruleset = loaded();
  const noArmor = { front: null, left: null, right: null, rear: null };

  function buildErrors(input: unknown): string[] {
    const result = validateBuild(ruleset, input);
    return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
  }

  it("accepts a valid Build and reports its cost", () => {
    const build = {
      chassis: "brawler",
      components: { ram: "spike", leftGun: "cannon", radar: "radar", drive: "tracks", bay: "coprocessor" },
      armor: { front: "plate", left: null, right: null, rear: "plate" },
    };
    expect(validateBuild(ruleset, build)).toEqual({
      ok: true,
      build,
      cost: 150 + 20 + 60 + 30 + 40 + 50 + 15 + 15,
    });
  });

  it("costs a bare Chassis at its own cost", () => {
    const result = validateBuild(ruleset, { chassis: "scout", components: {}, armor: noArmor });
    expect(result.ok && result.cost).toBe(60);
  });

  it("rejects Components in incompatible Slots", () => {
    expect(buildErrors({ chassis: "scout", components: { gun: "radar" }, armor: noArmor })).toEqual([
      'build.components.gun: "radar" does not fit the weapon Slot "gun"',
    ]);
    expect(buildErrors({ chassis: "scout", components: { drive: "plate" }, armor: noArmor })).toEqual([
      'build.components.drive: "plate" does not fit the motor Slot "drive"',
    ]);
  });

  it("rejects unknown parts and Slots", () => {
    expect(buildErrors({ chassis: "tank", components: {}, armor: noArmor })).toEqual([
      'build.chassis: is the unknown Chassis "tank"',
    ]);
    expect(buildErrors({ chassis: "scout", components: { bay: "coprocessor", gun: "laser" }, armor: noArmor })).toEqual([
      'build.components.bay: is not a Slot of Chassis "scout"',
      'build.components.gun: is the unknown Component "laser"',
    ]);
  });

  it("allows only side-mounted Components as Armor", () => {
    expect(buildErrors({ chassis: "scout", components: {}, armor: { ...noArmor, front: "cannon" } })).toEqual([
      'build.armor.front: "cannon" is not side-mounted Armor',
    ]);
    expect(buildErrors({ chassis: "scout", components: {}, armor: { front: null, left: null, right: null } })).toEqual([
      "build.armor.rear: is required (null for none)",
    ]);
    expect(buildErrors({ chassis: "scout", components: {}, armor: { ...noArmor, top: null } })).toEqual([
      "build.armor.top: is not a Build field",
    ]);
  });

  it("rejects malformed Builds", () => {
    expect(buildErrors("scout")).toEqual(["build: must be an object"]);
    expect(buildErrors({ chassis: "scout", armor: noArmor })).toEqual(["build.components: is required"]);
  });
});

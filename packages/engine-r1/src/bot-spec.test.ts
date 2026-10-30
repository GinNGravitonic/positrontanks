import type { Ruleset } from "@positrontanks/ruleset-data";
import { describe, expect, it } from "vitest";
import { checkRuleset, deriveBotSpec } from "./bot-spec.js";
import { armed, armored, boxBuild, discBuild, ruleset, without } from "./test-fixtures.js";

describe("deriveBotSpec", () => {
  it("derives a single-motor Bot's figures", () => {
    const spec = deriveBotSpec(ruleset, discBuild);
    expect(spec.mass).toBe(50);
    expect(spec.maxHitPoints).toBe(100);
    expect(spec.accel).toBe(10);
    expect(spec.topSpeed).toBe(10);
    expect(spec.turnRate).toBe(180);
    expect(spec.reach).toBe(0.5);
    expect(spec.motorTerrain).toEqual({ sand: { speed: 0.5, accel: 1 } });
    expect(spec.armor).toEqual({ front: 0, left: 0, right: 0, rear: 0 });
  });

  it("combines several motors: forces add, the slowest limits, the quickest turns", () => {
    const spec = deriveBotSpec(ruleset, { ...discBuild, components: { drive: "wheels", drive2: "tracks" } });
    expect(spec.mass).toBe(60);
    expect(spec.accel).toBeCloseTo(800 / 60, 12);
    expect(spec.topSpeed).toBe(6);
    expect(spec.turnRate).toBe((180 * 50) / 60);
    // On sand: wheels 10 * 0.5 = 5, tracks 6 * 2 = 12, so 5 of 6; force (500 + 600) / 800.
    expect(spec.motorTerrain).toEqual({ sand: { speed: 5 / 6, accel: 1.375 } });
  });

  it("adds Armor per side and its mass", () => {
    const spec = deriveBotSpec(ruleset, armored(boxBuild, { front: "plate", rear: "plate" }));
    expect(spec.armor).toEqual({ front: 5, left: 0, right: 0, rear: 5 });
    expect(spec.reach).toBeCloseTo(Math.sqrt(1.25), 12);
  });

  it("lists installed weapons in Slot order with their Slot's direction", () => {
    const spec = deriveBotSpec(ruleset, armed(discBuild, { tail: "turret", gun: "cannon" }));
    expect(spec.weapons).toEqual([
      { id: "gun", category: "projectile", direction: 0, arcWidth: 20, range: 40, reloadTicks: 5, damage: 30, projectileSpeed: 20 },
      { id: "tail", category: "beam", direction: 180, arcWidth: 360, range: 50, reloadTicks: 1, damage: 10, projectileSpeed: 0 },
    ]);
    expect(deriveBotSpec(ruleset, discBuild).weapons).toEqual([]);
  });

  it("leaves a Bot without motors unable to move", () => {
    const spec = deriveBotSpec(ruleset, { ...discBuild, components: {} });
    expect([spec.topSpeed, spec.accel, spec.turnRate]).toEqual([0, 0, 0]);
    expect(spec.motorTerrain).toEqual({});
  });

  it("lists installed sensors in Slot order with their Slot's direction", () => {
    const spec = deriveBotSpec(ruleset, armed(discBuild, { ear: "detector", eye: "lidar" }));
    expect(spec.sensors).toEqual([
      { id: "eye", kind: "rangefinder", direction: 0, arcWidth: 0, range: 20 },
      { id: "ear", kind: "projectileDetector", direction: 180, arcWidth: 360, range: 50 },
    ]);
    expect(deriveBotSpec(ruleset, discBuild).sensors).toEqual([]);
  });

  it("takes the Operation Budget from the Chassis or a better Processor", () => {
    expect(deriveBotSpec(ruleset, discBuild).operationBudget).toBe(1000);
    expect(deriveBotSpec(ruleset, armed(discBuild, { bay: "cpu" })).operationBudget).toBe(3000);
  });
});

describe("checkRuleset", () => {
  it("accepts a Ruleset with the stats engine-r1 reads", () => {
    expect(checkRuleset(ruleset)).toEqual([]);
  });

  it("requires the motor kind and its stats", () => {
    expect(checkRuleset({ ...ruleset, componentKinds: without(ruleset.componentKinds, "motor") })).toEqual([
      { path: "ruleset.componentKinds.motor", message: "is required by engine-r1" },
    ]);

    const motor = ruleset.componentKinds.motor;
    if (motor === undefined) throw new Error("fixture lacks motor");
    const stats = without(motor.stats, "maxSpeed");
    const broken: Ruleset = { ...ruleset, componentKinds: { ...ruleset.componentKinds, motor: { ...motor, stats } } };
    expect(checkRuleset(broken)).toEqual([
      { path: "ruleset.componentKinds.motor.stats.maxSpeed", message: "is required by engine-r1" },
    ]);
  });

  it("requires Chassis mass, Hit Points and Operation Budget, and armor on side-mounted kinds", () => {
    const broken: Ruleset = {
      ...ruleset,
      chassisStats: { mass: { type: "enum", values: ["light"] } },
      componentKinds: { ...ruleset.componentKinds, armor: { mount: "side", stats: {} } },
    };
    expect(checkRuleset(broken).map((e) => e.path)).toEqual([
      "ruleset.chassisStats.mass",
      "ruleset.chassisStats.hitPoints",
      "ruleset.chassisStats.operationBudget",
      "ruleset.componentKinds.armor.stats.armor",
    ]);
  });

  it("requires the weapon kind and its stats", () => {
    expect(checkRuleset({ ...ruleset, componentKinds: without(ruleset.componentKinds, "weapon") })).toEqual([
      { path: "ruleset.componentKinds.weapon", message: "is required by engine-r1" },
    ]);
    const weapon = ruleset.componentKinds.weapon;
    if (weapon === undefined) throw new Error("fixture lacks weapon");
    const stats = { ...without(weapon.stats, "projectileSpeed"), category: { type: "number" as const } };
    const broken: Ruleset = { ...ruleset, componentKinds: { ...ruleset.componentKinds, weapon: { ...weapon, stats } } };
    expect(checkRuleset(broken).map((e) => e.path)).toEqual([
      "ruleset.componentKinds.weapon.stats.category",
      "ruleset.componentKinds.weapon.stats.projectileSpeed",
    ]);
  });

  it("rejects weapon stats the engine cannot use", () => {
    const weapon = (stats: Record<string, number | string>) => ({
      id: "odd",
      name: "Odd",
      description: "Odd",
      kind: "weapon",
      cost: 5,
      slotTypes: ["weapon"],
      stats: { category: "beam", arcWidth: 30, range: 10, reloadTicks: 1, damage: 5, projectileSpeed: 0, ...stats },
    });
    const check = (stats: Record<string, number | string>) =>
      checkRuleset({ ...ruleset, components: [...ruleset.components, weapon(stats)] }).map((e) => e.path.split(".").pop());
    expect(check({})).toEqual([]);
    expect(check({ category: "flamer" })).toEqual(["category"]);
    expect(check({ arcWidth: 400 })).toEqual(["arcWidth"]);
    expect(check({ reloadTicks: 0.5 })).toEqual(["reloadTicks"]);
    expect(check({ range: -1, damage: -1 })).toEqual(["range", "damage"]);
    expect(check({ category: "projectile" })).toEqual(["projectileSpeed"]);
  });

  it("requires the sensor kind and its stats, and checks a processor kind if there is one", () => {
    expect(checkRuleset({ ...ruleset, componentKinds: without(ruleset.componentKinds, "sensor") })).toEqual([
      { path: "ruleset.componentKinds.sensor", message: "is required by engine-r1" },
    ]);
    expect(checkRuleset({ ...ruleset, componentKinds: without(ruleset.componentKinds, "processor") })).toEqual([]);
    const { sensor, processor } = ruleset.componentKinds;
    if (sensor === undefined || processor === undefined) throw new Error("fixture lacks sensor or processor");
    const broken: Ruleset = {
      ...ruleset,
      componentKinds: {
        ...ruleset.componentKinds,
        sensor: { mount: "side", stats: { ...without(sensor.stats, "range"), kind: { type: "number" } } },
        processor: { ...processor, stats: {} },
      },
    };
    expect(checkRuleset(broken).map((e) => e.path)).toEqual([
      "ruleset.componentKinds.sensor.mount",
      "ruleset.componentKinds.sensor.stats.kind",
      "ruleset.componentKinds.sensor.stats.range",
      "ruleset.componentKinds.processor.stats.operationBudget",
      "ruleset.componentKinds.sensor.stats.armor", // side-mounted kinds need armor
    ]);
  });

  it("rejects sensor and Operation Budget stats the engine cannot use", () => {
    const part = (kind: string, stats: Record<string, number | string>) => ({ id: "odd", name: "Odd", description: "Odd", kind, cost: 5, slotTypes: [kind], stats });
    const check = (kind: string, stats: Record<string, number | string>) =>
      checkRuleset({ ...ruleset, components: [...ruleset.components, part(kind, stats)] }).map((e) => e.path.split(".").pop());
    const sensor = { kind: "radar", arcWidth: 90, range: 10 };
    expect(check("sensor", sensor)).toEqual([]);
    expect(check("sensor", { ...sensor, kind: "sonar" })).toEqual(["kind"]);
    expect(check("sensor", { ...sensor, arcWidth: -1, range: -1 })).toEqual(["arcWidth", "range"]);
    expect(check("processor", { operationBudget: 0 })).toEqual(["operationBudget"]);
    expect(check("processor", { operationBudget: 1.5 })).toEqual(["operationBudget"]);
    const [disc, box] = ruleset.chassis;
    if (disc === undefined || box === undefined) throw new Error("fixture lacks Chassis");
    const broken: Ruleset = { ...ruleset, chassis: [{ ...disc, stats: { ...disc.stats, operationBudget: 0 } }, box] };
    expect(checkRuleset(broken).map((e) => e.path)).toEqual(["ruleset.chassis[0].stats.operationBudget"]);
  });

  it("rejects a massless Chassis", () => {
    const [disc, box] = ruleset.chassis;
    if (disc === undefined || box === undefined) throw new Error("fixture lacks Chassis");
    const broken: Ruleset = { ...ruleset, chassis: [{ ...disc, stats: { ...disc.stats, mass: 0 } }, box] };
    expect(checkRuleset(broken)).toEqual([
      { path: "ruleset.chassis[0].stats.mass", message: "must be greater than 0 for engine-r1" },
    ]);
  });
});

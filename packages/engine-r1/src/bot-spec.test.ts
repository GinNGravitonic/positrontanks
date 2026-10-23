import type { Ruleset } from "@aumohta/ruleset-data";
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

  it("lists installed weapons in Slot order with their Slot's muzzle and direction", () => {
    const spec = deriveBotSpec(ruleset, armed(discBuild, { tail: "turret", gun: "cannon" }));
    expect(spec.weapons).toEqual([
      { id: "gun", category: "projectile", x: 0, y: -0.4, direction: 0, arcWidth: 20, range: 40, reloadTicks: 5, damage: 30, projectileSpeed: 20 },
      { id: "tail", category: "beam", x: 0, y: 0.4, direction: 180, arcWidth: 360, range: 50, reloadTicks: 1, damage: 10, projectileSpeed: 0 },
    ]);
    expect(deriveBotSpec(ruleset, discBuild).weapons).toEqual([]);
  });

  it("leaves a Bot without motors unable to move", () => {
    const spec = deriveBotSpec(ruleset, { ...discBuild, components: {} });
    expect([spec.topSpeed, spec.accel, spec.turnRate]).toEqual([0, 0, 0]);
    expect(spec.motorTerrain).toEqual({});
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

  it("requires Chassis mass and Hit Points, and armor on side-mounted kinds", () => {
    const broken: Ruleset = {
      ...ruleset,
      chassisStats: { mass: { type: "enum", values: ["light"] } },
      componentKinds: { ...ruleset.componentKinds, armor: { mount: "side", stats: {} } },
    };
    expect(checkRuleset(broken).map((e) => e.path)).toEqual([
      "ruleset.chassisStats.mass",
      "ruleset.chassisStats.hitPoints",
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

  it("rejects a massless Chassis", () => {
    const [disc, box] = ruleset.chassis;
    if (disc === undefined || box === undefined) throw new Error("fixture lacks Chassis");
    const broken: Ruleset = { ...ruleset, chassis: [{ ...disc, stats: { ...disc.stats, mass: 0 } }, box] };
    expect(checkRuleset(broken)).toEqual([
      { path: "ruleset.chassis[0].stats.mass", message: "must be greater than 0 for engine-r1" },
    ]);
  });
});

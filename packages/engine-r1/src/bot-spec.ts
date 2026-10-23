/**
 * What engine-r1 reads from a Ruleset, and the figures it derives from a Build.
 *
 * Rulesets declare open-ended stat sets (ADR-0004); this module is where
 * engine-r1 says which stats it gives meaning to. checkRuleset reports a
 * Ruleset that lacks them, and deriveBotSpec turns a valid Build into the
 * numbers the simulation uses. The rules are in docs/spec/engine-r1.md.
 */

// Types only: the engine keeps no runtime dependency on ruleset-data, so a
// change there can never change how a frozen Ruleset plays.
import type {
  ArmorSide,
  Build,
  Chassis,
  Component,
  Ruleset,
  RulesetError,
  StatDefinition,
  Stats,
  TerrainMultipliers,
} from "@aumohta/ruleset-data";
import { shapeReach, type LocalShape } from "./geometry.js";

export const ARMOR_SIDES: readonly ArmorSide[] = ["front", "left", "right", "rear"];

/** The Component kind whose Components drive and turn the Bot. */
export const MOTOR_KIND = "motor";

const CHASSIS_STATS = ["mass", "hitPoints"] as const;
const MOTOR_STATS = ["force", "maxSpeed", "turnRate"] as const;

/** The figures the simulation uses for one Bot, derived from its Build. */
export interface BotSpec {
  readonly chassis: Chassis;
  readonly shape: LocalShape;
  /** The distance from the centre to the farthest point of the shape, in meters. */
  readonly reach: number;
  /** Chassis mass plus the mass of every installed Component, in kg. */
  readonly mass: number;
  readonly maxHitPoints: number;
  /** Top speed on a Terrain with multiplier 1, in m/s. */
  readonly topSpeed: number;
  /** Acceleration on a Terrain with multiplier 1, in m/s². */
  readonly accel: number;
  /** Maximum turn rate, in degrees/s. */
  readonly turnRate: number;
  /** Per-Terrain motor modifiers, in the Ruleset's Terrain order; Terrains with no effect are omitted. */
  readonly motorTerrain: Readonly<Record<string, TerrainMultipliers>>;
  readonly armor: Readonly<Record<ArmorSide, number>>;
}

function requireNumberStat(
  errors: RulesetError[],
  defs: Readonly<Record<string, StatDefinition>>,
  name: string,
  path: string,
): void {
  const def = Object.hasOwn(defs, name) ? defs[name] : undefined;
  if (def === undefined) errors.push({ path: `${path}.${name}`, message: "is required by engine-r1" });
  else if (def.type !== "number") errors.push({ path: `${path}.${name}`, message: 'must be of type "number" for engine-r1' });
}

function statNumber(stats: Stats, name: string): number {
  const v = Object.hasOwn(stats, name) ? stats[name] : undefined;
  return typeof v === "number" ? v : 0;
}

function checkNonNegative(errors: RulesetError[], stats: Stats, name: string, path: string, positive = false): void {
  const v = statNumber(stats, name);
  if (positive ? v <= 0 : v < 0) {
    errors.push({ path: `${path}.stats.${name}`, message: `must be ${positive ? "greater than 0" : "at least 0"} for engine-r1` });
  }
}

/**
 * Reports what a structurally valid Ruleset lacks for engine-r1: the stats
 * the simulation reads, with the right types and signs.
 */
export function checkRuleset(ruleset: Ruleset): RulesetError[] {
  const errors: RulesetError[] = [];
  for (const name of CHASSIS_STATS) requireNumberStat(errors, ruleset.chassisStats, name, "ruleset.chassisStats");

  const motor = Object.hasOwn(ruleset.componentKinds, MOTOR_KIND) ? ruleset.componentKinds[MOTOR_KIND] : undefined;
  if (motor === undefined) {
    errors.push({ path: `ruleset.componentKinds.${MOTOR_KIND}`, message: "is required by engine-r1" });
  } else {
    const path = `ruleset.componentKinds.${MOTOR_KIND}`;
    if (motor.mount !== "slot") errors.push({ path: `${path}.mount`, message: 'must be "slot" for engine-r1' });
    for (const name of MOTOR_STATS) requireNumberStat(errors, motor.stats, name, `${path}.stats`);
    const terrain = Object.hasOwn(motor.stats, "motorTerrain") ? motor.stats.motorTerrain : undefined;
    if (terrain?.type !== "terrainModifiers") {
      errors.push({ path: `${path}.stats.motorTerrain`, message: 'must be of type "terrainModifiers" for engine-r1' });
    }
  }

  for (const [kindName, kind] of Object.entries(ruleset.componentKinds)) {
    const path = `ruleset.componentKinds.${kindName}.stats`;
    if (kind.mount === "side") requireNumberStat(errors, kind.stats, "armor", path);
    if (Object.hasOwn(kind.stats, "mass") && kind.stats.mass?.type !== "number") {
      errors.push({ path: `${path}.mass`, message: 'must be of type "number" for engine-r1' });
    }
  }
  if (errors.length > 0) return errors;

  ruleset.chassis.forEach((c, i) => {
    const path = `ruleset.chassis[${String(i)}]`;
    checkNonNegative(errors, c.stats, "mass", path, true);
    checkNonNegative(errors, c.stats, "hitPoints", path, true);
  });
  ruleset.components.forEach((c, i) => {
    const path = `ruleset.components[${String(i)}]`;
    checkNonNegative(errors, c.stats, "mass", path);
    if (c.kind === MOTOR_KIND) for (const name of MOTOR_STATS) checkNonNegative(errors, c.stats, name, path);
    if (ruleset.componentKinds[c.kind]?.mount === "side") checkNonNegative(errors, c.stats, "armor", path);
  });
  return errors;
}

function motorModifier(motor: Component, terrain: string): TerrainMultipliers {
  const mods = motor.stats.motorTerrain;
  if (typeof mods !== "object") return { speed: 1, accel: 1 };
  return Object.hasOwn(mods, terrain) ? (mods[terrain] ?? { speed: 1, accel: 1 }) : { speed: 1, accel: 1 };
}

/**
 * The simulation figures for a Build that validateBuild accepted under this
 * Ruleset, which must also pass checkRuleset.
 *
 * With several motors, drive forces add, the slowest motor's top speed
 * limits the Bot, and the quickest-turning motor sets the turn rate. A
 * motor's turnRate is its rate on the bare Chassis, scaled down by the
 * Bot's total mass.
 */
export function deriveBotSpec(ruleset: Ruleset, build: Build): BotSpec {
  const chassis = ruleset.chassis.find((c) => c.id === build.chassis);
  if (chassis === undefined) throw new Error(`unknown Chassis "${build.chassis}"`);
  const componentsById = new Map(ruleset.components.map((c) => [c.id, c]));
  const find = (id: string): Component => {
    const component = componentsById.get(id);
    if (component === undefined) throw new Error(`unknown Component "${id}"`);
    return component;
  };

  const installed = chassis.slots.flatMap((slot) => {
    const id = Object.hasOwn(build.components, slot.id) ? build.components[slot.id] : undefined;
    return id === undefined ? [] : [find(id)];
  });
  const armor = {} as Record<ArmorSide, number>;
  let mass = statNumber(chassis.stats, "mass");
  for (const component of installed) mass += statNumber(component.stats, "mass");
  for (const side of ARMOR_SIDES) {
    const id = build.armor[side];
    const component = id === null ? undefined : find(id);
    armor[side] = component === undefined ? 0 : statNumber(component.stats, "armor");
    if (component !== undefined) mass += statNumber(component.stats, "mass");
  }

  const motors = installed.filter((c) => c.kind === MOTOR_KIND);
  let force = 0;
  let topSpeed = motors.length === 0 ? 0 : Infinity;
  let bareTurnRate = 0;
  for (const m of motors) {
    force += statNumber(m.stats, "force");
    topSpeed = Math.min(topSpeed, statNumber(m.stats, "maxSpeed"));
    bareTurnRate = Math.max(bareTurnRate, statNumber(m.stats, "turnRate"));
  }

  // The Build's modifier for a Terrain is what that Terrain does to its
  // combined top speed and force, so a single motor's modifiers carry over as is.
  const motorTerrain: Record<string, TerrainMultipliers> = {};
  for (const { name } of ruleset.terrains) {
    let speed = 1;
    let accel = 1;
    if (topSpeed > 0) {
      let limited = Infinity;
      for (const m of motors) limited = Math.min(limited, statNumber(m.stats, "maxSpeed") * motorModifier(m, name).speed);
      speed = limited / topSpeed;
    }
    if (force > 0) {
      let modified = 0;
      for (const m of motors) modified += statNumber(m.stats, "force") * motorModifier(m, name).accel;
      accel = modified / force;
    }
    if (speed !== 1 || accel !== 1) motorTerrain[name] = { speed, accel };
  }

  const shape: LocalShape =
    chassis.shape.shape === "circle"
      ? { shape: "circle", radius: chassis.shape.radius }
      : { shape: "polygon", points: chassis.shape.points };
  return {
    chassis,
    shape,
    reach: shapeReach(shape),
    mass,
    maxHitPoints: statNumber(chassis.stats, "hitPoints"),
    topSpeed,
    accel: force / mass,
    turnRate: (bareTurnRate * statNumber(chassis.stats, "mass")) / mass,
    motorTerrain,
    armor,
  };
}

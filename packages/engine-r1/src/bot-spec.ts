/**
 * What engine-r1 reads from a Ruleset, and the figures it derives from a Build.
 *
 * Rulesets declare open-ended stat sets (ADR-0004); this module is where
 * engine-r1 says which stats it gives meaning to. checkRuleset reports a
 * Ruleset that lacks them, and deriveBotSpec turns a valid Build into the
 * numbers the simulation uses. The rules are in ruleset-data/spec/r1/engine-r1.md.
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
/** The Component kind whose Components fire. */
export const WEAPON_KIND = "weapon";

/** The Component kind whose Components detect things around the Bot. */
export const SENSOR_KIND = "sensor";
/** The Component kind whose Components raise the Operation Budget; optional in a Ruleset. */
export const PROCESSOR_KIND = "processor";

export const WEAPON_CATEGORIES = ["melee", "projectile", "beam"] as const;
export type WeaponCategory = (typeof WEAPON_CATEGORIES)[number];

export const SENSOR_KINDS = ["radar", "rangefinder", "projectileDetector"] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];

const CHASSIS_STATS = ["mass", "hitPoints", "operationBudget"] as const;
const MOTOR_STATS = ["force", "maxSpeed", "turnRate"] as const;
const WEAPON_STATS = ["arcWidth", "range", "reloadTicks", "damage", "projectileSpeed"] as const;
const SENSOR_STATS = ["arcWidth", "range"] as const;

/** An installed weapon, as the simulation uses it. */
export interface WeaponSpec {
  /** The Slot name, which Programs use as the weapon id. */
  readonly id: string;
  readonly category: WeaponCategory;
  /** The Slot direction relative to the Heading, in (-180, 180]: the centre of the Firing Arc. */
  readonly direction: number;
  /** Degrees, in [0, 360]. */
  readonly arcWidth: number;
  /** Meters from the Bot's centre. */
  readonly range: number;
  readonly reloadTicks: number;
  readonly damage: number;
  /** m/s; 0 for weapons other than Projectile Weapons. */
  readonly projectileSpeed: number;
}

/** An installed sensor, as the simulation uses it. */
export interface SensorSpec {
  /** The Slot name, which Programs use as the sensor id. */
  readonly id: string;
  readonly kind: SensorKind;
  /** The Slot direction relative to the Heading, in (-180, 180]: the centre of the sensor's arc. */
  readonly direction: number;
  /** Degrees, in [0, 360]. A Rangefinder looks along the Slot direction only. */
  readonly arcWidth: number;
  /** Meters from the Bot's centre. */
  readonly range: number;
}

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
  /** In Slot order. */
  readonly weapons: readonly WeaponSpec[];
  /** In Slot order. */
  readonly sensors: readonly SensorSpec[];
  /** Operations per Tick: the highest `operationBudget` of the Chassis and any installed Processor. */
  readonly operationBudget: number;
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

function isWeaponCategory(v: unknown): v is WeaponCategory {
  return WEAPON_CATEGORIES.some((c) => c === v);
}

function isSensorKind(v: unknown): v is SensorKind {
  return SENSOR_KINDS.some((k) => k === v);
}

function checkWholeNumber(errors: RulesetError[], stats: Stats, name: string, path: string): void {
  const v = statNumber(stats, name);
  if (!Number.isInteger(v) || v < 1) {
    errors.push({ path: `${path}.stats.${name}`, message: "must be a whole number of at least 1 for engine-r1" });
  }
}

function checkArcWidth(errors: RulesetError[], stats: Stats, path: string): void {
  const arcWidth = statNumber(stats, "arcWidth");
  if (arcWidth < 0 || arcWidth > 360) errors.push({ path: `${path}.stats.arcWidth`, message: "must be from 0 to 360 for engine-r1" });
}

/** The kind's definition, if the Ruleset declares it. */
function kindOf(ruleset: Ruleset, name: string) {
  return Object.hasOwn(ruleset.componentKinds, name) ? ruleset.componentKinds[name] : undefined;
}

function checkEnumStat(errors: RulesetError[], stats: Readonly<Record<string, StatDefinition>>, name: string, path: string): void {
  const def = Object.hasOwn(stats, name) ? stats[name] : undefined;
  if (def?.type !== "enum") errors.push({ path: `${path}.stats.${name}`, message: 'must be of type "enum" for engine-r1' });
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

  const weapon = kindOf(ruleset, WEAPON_KIND);
  if (weapon === undefined) {
    errors.push({ path: `ruleset.componentKinds.${WEAPON_KIND}`, message: "is required by engine-r1" });
  } else {
    const path = `ruleset.componentKinds.${WEAPON_KIND}`;
    if (weapon.mount !== "slot") errors.push({ path: `${path}.mount`, message: 'must be "slot" for engine-r1' });
    checkEnumStat(errors, weapon.stats, "category", path);
    for (const name of WEAPON_STATS) requireNumberStat(errors, weapon.stats, name, `${path}.stats`);
  }

  const sensor = kindOf(ruleset, SENSOR_KIND);
  if (sensor === undefined) {
    errors.push({ path: `ruleset.componentKinds.${SENSOR_KIND}`, message: "is required by engine-r1" });
  } else {
    const path = `ruleset.componentKinds.${SENSOR_KIND}`;
    if (sensor.mount !== "slot") errors.push({ path: `${path}.mount`, message: 'must be "slot" for engine-r1' });
    checkEnumStat(errors, sensor.stats, "kind", path);
    for (const name of SENSOR_STATS) requireNumberStat(errors, sensor.stats, name, `${path}.stats`);
  }

  const processor = kindOf(ruleset, PROCESSOR_KIND);
  if (processor !== undefined) {
    const path = `ruleset.componentKinds.${PROCESSOR_KIND}`;
    if (processor.mount !== "slot") errors.push({ path: `${path}.mount`, message: 'must be "slot" for engine-r1' });
    requireNumberStat(errors, processor.stats, "operationBudget", `${path}.stats`);
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
    checkWholeNumber(errors, c.stats, "operationBudget", path);
  });
  ruleset.components.forEach((c, i) => {
    const path = `ruleset.components[${String(i)}]`;
    checkNonNegative(errors, c.stats, "mass", path);
    if (c.kind === MOTOR_KIND) for (const name of MOTOR_STATS) checkNonNegative(errors, c.stats, name, path);
    if (ruleset.componentKinds[c.kind]?.mount === "side") checkNonNegative(errors, c.stats, "armor", path);
    if (c.kind === WEAPON_KIND) checkWeapon(errors, c, path);
    if (c.kind === SENSOR_KIND) checkSensor(errors, c, path);
    if (c.kind === PROCESSOR_KIND) checkWholeNumber(errors, c.stats, "operationBudget", path);
  });
  return errors;
}

function oneOf(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

function checkWeapon(errors: RulesetError[], c: Component, path: string): void {
  const category = c.stats.category;
  if (!isWeaponCategory(category)) {
    errors.push({ path: `${path}.stats.category`, message: `must be one of ${oneOf(WEAPON_CATEGORIES)} for engine-r1` });
  }
  checkArcWidth(errors, c.stats, path);
  checkNonNegative(errors, c.stats, "range", path);
  checkWholeNumber(errors, c.stats, "reloadTicks", path);
  checkNonNegative(errors, c.stats, "damage", path);
  checkNonNegative(errors, c.stats, "projectileSpeed", path, category === "projectile");
}

function checkSensor(errors: RulesetError[], c: Component, path: string): void {
  if (!isSensorKind(c.stats.kind)) {
    errors.push({ path: `${path}.stats.kind`, message: `must be one of ${oneOf(SENSOR_KINDS)} for engine-r1` });
  }
  checkArcWidth(errors, c.stats, path);
  checkNonNegative(errors, c.stats, "range", path);
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

  const mounted = chassis.slots.flatMap((slot) => {
    const id = Object.hasOwn(build.components, slot.id) ? build.components[slot.id] : undefined;
    return id === undefined ? [] : [{ slot, component: find(id) }];
  });
  const installed = mounted.map((m) => m.component);
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

  const weapons = mounted.flatMap(({ slot, component: c }): WeaponSpec[] => {
    const category = c.stats.category;
    if (c.kind !== WEAPON_KIND || !isWeaponCategory(category)) return [];
    return [
      {
        id: slot.id,
        category,
        direction: slot.direction,
        arcWidth: statNumber(c.stats, "arcWidth"),
        range: statNumber(c.stats, "range"),
        reloadTicks: statNumber(c.stats, "reloadTicks"),
        damage: statNumber(c.stats, "damage"),
        projectileSpeed: category === "projectile" ? statNumber(c.stats, "projectileSpeed") : 0,
      },
    ];
  });

  const sensors = mounted.flatMap(({ slot, component: c }): SensorSpec[] => {
    const kind = c.stats.kind;
    if (c.kind !== SENSOR_KIND || !isSensorKind(kind)) return [];
    return [
      {
        id: slot.id,
        kind,
        direction: slot.direction,
        arcWidth: statNumber(c.stats, "arcWidth"),
        range: statNumber(c.stats, "range"),
      },
    ];
  });

  let operationBudget = statNumber(chassis.stats, "operationBudget");
  for (const c of installed) {
    if (c.kind === PROCESSOR_KIND) operationBudget = Math.max(operationBudget, statNumber(c.stats, "operationBudget"));
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
    weapons,
    sensors,
    operationBudget,
  };
}

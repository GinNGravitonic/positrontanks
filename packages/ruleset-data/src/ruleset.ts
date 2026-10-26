/**
 * Ruleset data (spec section 5, ADR-0004).
 *
 * A Ruleset is self-describing: besides its catalog it declares the stats
 * every Chassis must carry (`chassisStats`) and, per Component kind, how such
 * Components mount and which stats they carry (`componentKinds`). Stats are
 * open-ended sets keyed by name, so a later Ruleset adds a mechanic by
 * declaring new stats, not by changing this schema. What a stat means is up
 * to that Ruleset's frozen engine.
 *
 * A Component may carry a `visualSize` beside its artwork reference: how big
 * clients draw it, in meters, from its Slot along and across the Slot
 * direction. It is never a stat and no engine reads it; validation only caps
 * each dimension at the largest dimension of any Chassis, so a Component
 * cannot be drawn absurdly large. Overlap between drawn Components is never
 * checked.
 *
 * Shapes and Slot positions are in the Bot frame: meters from the Bot's
 * centre, x to the right, y down, with the Heading pointing up (-y). Slot
 * directions are bearings relative to the Heading, in (-180, 180].
 *
 * Like Map Format 1, validation is strict (unknown fields are errors) and
 * reports every problem it finds, each with a path such as
 * `ruleset.chassis[0].slots[1].type`. Cross-references (Slot types, Terrain
 * names, stat declarations) are checked once the parts they refer to are valid.
 */

import { isSimplePolygon, pointInPolygon, polygonArea2, type Point } from "./geometry.js";

export const SUPPORTED_MAP_FORMATS: readonly number[] = [1];

export const ARMOR_SIDES = ["front", "left", "right", "rear"] as const;
export type ArmorSide = (typeof ARMOR_SIDES)[number];

export interface TerrainMultipliers {
  readonly speed: number;
  readonly accel: number;
}

export interface Terrain extends TerrainMultipliers {
  readonly name: string;
}

/** Per-Terrain multipliers keyed by Terrain name, as a motor's `motorTerrain` modifiers. */
export type TerrainModifiers = Readonly<Record<string, TerrainMultipliers>>;

export type StatDefinition =
  | {
      readonly type: "number";
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
    }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "terrainModifiers" };

export type StatValue = number | string | TerrainModifiers;
export type Stats = Readonly<Record<string, StatValue>>;

export interface ComponentKind {
  /** `slot`: installed in a compatible Slot. `side`: bought per side, as Armor. */
  readonly mount: "slot" | "side";
  readonly stats: Readonly<Record<string, StatDefinition>>;
}

/** A Chassis outline in the Bot frame; a circle is centred on the Bot's centre. */
export type ChassisShape =
  | { readonly shape: "circle"; readonly radius: number }
  | { readonly shape: "polygon"; readonly points: readonly Point[] };

export interface Slot {
  /** The Slot name, which Programs use as a weapon or sensor id. */
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  /** Facing relative to the Heading, in (-180, 180]. */
  readonly direction: number;
}

export interface Chassis {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly shape: ChassisShape;
  readonly slots: readonly Slot[];
  readonly stats: Stats;
  /** Top-down SVG reference; absent means a placeholder. */
  readonly artwork?: string;
}

/**
 * How big a client draws a Component, in meters. Its origin is the Slot;
 * `length` runs along the Slot direction and `width` across it. Purely visual:
 * engines never read it.
 */
export interface VisualSize {
  readonly length: number;
  readonly width: number;
}

export interface Component {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly cost: number;
  /** The Slot types it fits; empty for side-mounted kinds. */
  readonly slotTypes: readonly string[];
  readonly stats: Stats;
  /** Top-down SVG reference; absent means a placeholder. */
  readonly artwork?: string;
  /** Drawn size for clients; Slot-mounted Components only. */
  readonly visualSize?: VisualSize;
}

/** Language limits (language-r1 section 11). */
export interface RulesetLimits {
  readonly initBudgetMultiplier: number;
  readonly memoryCells: number;
  readonly maxCallDepth: number;
  readonly maxCollectionLength: number;
  readonly maxSourceBytes: number;
  readonly logLinesPerTick: number;
  readonly logLineLength: number;
}

export interface Ruleset {
  readonly version: string;
  /** Ticks per simulated second. */
  readonly tickRate: number;
  /** The range an Initiator may choose a Game's Point Budget from. */
  readonly pointBudget: { readonly min: number; readonly max: number };
  readonly mapFormats: readonly number[];
  /** In declared order, which is the order `terrainTable()` reports. */
  readonly terrains: readonly Terrain[];
  readonly limits: RulesetLimits;
  readonly slotTypes: readonly string[];
  readonly chassisStats: Readonly<Record<string, StatDefinition>>;
  readonly componentKinds: Readonly<Record<string, ComponentKind>>;
  readonly chassis: readonly Chassis[];
  readonly components: readonly Component[];
}

export interface RulesetError {
  readonly path: string;
  readonly message: string;
}

export type RulesetResult =
  | { readonly ok: true; readonly ruleset: Ruleset }
  | { readonly ok: false; readonly errors: readonly RulesetError[] };

const LIMIT_KEYS = [
  "initBudgetMultiplier",
  "memoryCells",
  "maxCallDepth",
  "maxCollectionLength",
  "maxSourceBytes",
  "logLinesPerTick",
  "logLineLength",
] as const;

// Names start with a letter, so they never clash with Object.prototype members
// and never get reordered as integer-like record keys (language-r1 section 12).
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NAME_RULE = "must be 1-32 letters, digits or '_', starting with a letter";
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ID_RULE = "must be 1-64 letters, digits, '-' or '_', starting with a letter";

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Reader {
  readonly errors: RulesetError[] = [];

  /** `noun` names what is being read in unknown-field errors. */
  constructor(readonly noun: "Ruleset" | "Build") {}

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  keys(obj: Json, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.error(`${path}.${key}`, `is not a ${this.noun} field`);
    }
  }

  record(obj: Json, key: string, path: string): Json | undefined {
    const v = obj[key];
    if (v === undefined) this.error(`${path}.${key}`, "is required");
    else if (!isRecord(v)) this.error(`${path}.${key}`, "must be an object");
    else return v;
    return undefined;
  }

  number(obj: Json, key: string, path: string): number | undefined {
    const v = obj[key];
    if (v === undefined) {
      this.error(`${path}.${key}`, "is required");
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.error(`${path}.${key}`, "must be a finite number");
      return undefined;
    }
    return v;
  }

  positive(obj: Json, key: string, path: string): number | undefined {
    const v = this.number(obj, key, path);
    if (v !== undefined && v <= 0) {
      this.error(`${path}.${key}`, "must be greater than 0");
      return undefined;
    }
    return v;
  }

  whole(obj: Json, key: string, path: string, min: number): number | undefined {
    const v = this.number(obj, key, path);
    if (v !== undefined && (!Number.isInteger(v) || v < min)) {
      this.error(`${path}.${key}`, `must be a whole number of at least ${String(min)}`);
      return undefined;
    }
    return v;
  }

  string(obj: Json, key: string, path: string, pattern?: RegExp, rule?: string): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      this.error(`${path}.${key}`, "is required");
      return undefined;
    }
    if (typeof v !== "string" || v === "") {
      this.error(`${path}.${key}`, "must be a non-empty string");
      return undefined;
    }
    if (pattern && !pattern.test(v)) {
      this.error(`${path}.${key}`, rule ?? "is not valid");
      return undefined;
    }
    return v;
  }

  optionalString(obj: Json, key: string, path: string): string | undefined {
    return obj[key] === undefined ? undefined : this.string(obj, key, path);
  }

  list<T>(obj: Json, key: string, path: string, item: (v: unknown, path: string) => T | undefined): T[] | undefined {
    const v = obj[key];
    const listPath = `${path}.${key}`;
    if (v === undefined) {
      this.error(listPath, "is required");
      return undefined;
    }
    if (!Array.isArray(v)) {
      this.error(listPath, "must be a list");
      return undefined;
    }
    const out: T[] = [];
    v.forEach((element: unknown, i) => {
      const parsed = item(element, `${listPath}[${String(i)}]`);
      if (parsed !== undefined) out.push(parsed);
    });
    return out.length === v.length ? out : undefined;
  }

  objects<T>(obj: Json, key: string, path: string, item: (v: Json, path: string) => T | undefined): T[] | undefined {
    return this.list(obj, key, path, (element, itemPath) => {
      if (isRecord(element)) return item(element, itemPath);
      this.error(itemPath, "must be an object");
      return undefined;
    });
  }

  /** Reads an object whose keys are names, each mapped by `entry`. */
  named<T>(obj: Json, key: string, path: string, entry: (v: unknown, path: string) => T | undefined) {
    const v = this.record(obj, key, path);
    if (v === undefined) return undefined;
    const out: Record<string, T> = {};
    let valid = true;
    for (const [name, value] of Object.entries(v)) {
      const entryPath = `${path}.${key}.${name}`;
      if (!NAME.test(name)) {
        this.error(entryPath, `has an invalid name: names ${NAME_RULE}`);
        valid = false;
        continue;
      }
      const parsed = entry(value, entryPath);
      if (parsed === undefined) valid = false;
      else out[name] = parsed;
    }
    return valid ? out : undefined;
  }

  /** Records the path of each id in `ids`, reporting duplicates. */
  unique(ids: Map<string, string>, id: string, path: string): void {
    const first = ids.get(id);
    if (first === undefined) ids.set(id, path);
    else this.error(path, `duplicates ${first} "${id}"`);
  }
}

function readMultipliers(r: Reader, v: unknown, path: string): TerrainMultipliers | undefined {
  if (!isRecord(v)) {
    r.error(path, "must be an object of {speed, accel} multipliers");
    return undefined;
  }
  r.keys(v, ["speed", "accel"], path);
  const speed = r.positive(v, "speed", path);
  const accel = r.positive(v, "accel", path);
  return speed === undefined || accel === undefined ? undefined : { speed, accel };
}

function readTerrain(r: Reader, names: Map<string, string>, obj: Json, path: string): Terrain | undefined {
  r.keys(obj, ["name", "speed", "accel"], path);
  const name = r.string(obj, "name", path, NAME, NAME_RULE);
  if (name !== undefined) r.unique(names, name, `${path}.name`);
  const multipliers = readMultipliers(r, { speed: obj.speed, accel: obj.accel }, path);
  return name === undefined || multipliers === undefined ? undefined : { name, ...multipliers };
}

function readStatDefinition(r: Reader, v: unknown, path: string): StatDefinition | undefined {
  if (!isRecord(v)) {
    r.error(path, "must be a stat definition object");
    return undefined;
  }
  switch (v.type) {
    case "number": {
      r.keys(v, ["type", "min", "max", "integer"], path);
      const min = v.min === undefined ? undefined : r.number(v, "min", path);
      const max = v.max === undefined ? undefined : r.number(v, "max", path);
      if (v.integer !== undefined && typeof v.integer !== "boolean") {
        r.error(`${path}.integer`, "must be true or false");
        return undefined;
      }
      if ((v.min !== undefined && min === undefined) || (v.max !== undefined && max === undefined)) return undefined;
      if (min !== undefined && max !== undefined && min > max) {
        r.error(path, "must have min at most max");
        return undefined;
      }
      return {
        type: "number",
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(v.integer === undefined ? {} : { integer: v.integer }),
      };
    }
    case "enum": {
      r.keys(v, ["type", "values"], path);
      const seen = new Map<string, string>();
      const values = r.list(v, "values", path, (value, valuePath) => {
        if (typeof value !== "string" || value === "") {
          r.error(valuePath, "must be a non-empty string");
          return undefined;
        }
        r.unique(seen, value, valuePath);
        return value;
      });
      if (values === undefined) return undefined;
      if (values.length === 0) {
        r.error(`${path}.values`, "must not be empty");
        return undefined;
      }
      return { type: "enum", values };
    }
    case "terrainModifiers":
      r.keys(v, ["type"], path);
      return { type: "terrainModifiers" };
    default:
      r.error(`${path}.type`, v.type === undefined ? "is required" : 'must be "number", "enum" or "terrainModifiers"');
      return undefined;
  }
}

function readComponentKind(r: Reader, v: unknown, path: string): ComponentKind | undefined {
  if (!isRecord(v)) {
    r.error(path, "must be an object");
    return undefined;
  }
  r.keys(v, ["mount", "stats"], path);
  if (v.mount !== "slot" && v.mount !== "side") {
    r.error(`${path}.mount`, v.mount === undefined ? "is required" : 'must be "slot" or "side"');
  }
  const stats = r.named(v, "stats", path, (def, defPath) => readStatDefinition(r, def, defPath));
  if ((v.mount !== "slot" && v.mount !== "side") || stats === undefined) return undefined;
  return { mount: v.mount, stats };
}

function readPoint(r: Reader, v: unknown, path: string): Point | undefined {
  if (!isRecord(v)) {
    r.error(path, "must be an {x, y} point");
    return undefined;
  }
  r.keys(v, ["x", "y"], path);
  const x = r.number(v, "x", path);
  const y = r.number(v, "y", path);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readChassisShape(r: Reader, obj: Json, path: string): ChassisShape | undefined {
  const v = r.record(obj, "shape", path);
  if (v === undefined) return undefined;
  const shapePath = `${path}.shape`;
  if (v.shape === "circle") {
    r.keys(v, ["shape", "radius"], shapePath);
    const radius = r.positive(v, "radius", shapePath);
    return radius === undefined ? undefined : { shape: "circle", radius };
  }
  if (v.shape === "polygon") {
    r.keys(v, ["shape", "points"], shapePath);
    const points = r.list(v, "points", shapePath, (p, pointPath) => readPoint(r, p, pointPath));
    if (points === undefined) return undefined;
    const pointsPath = `${shapePath}.points`;
    if (points.length < 3) r.error(pointsPath, "must have at least 3 points");
    else if (polygonArea2(points) === 0) r.error(pointsPath, "must enclose a non-zero area");
    else if (!isSimplePolygon(points)) r.error(pointsPath, "must not cross or touch itself");
    else if (!pointInPolygon({ x: 0, y: 0 }, points)) r.error(pointsPath, "must contain the Bot's centre (0, 0)");
    else return { shape: "polygon", points };
    return undefined;
  }
  r.error(`${shapePath}.shape`, v.shape === undefined ? "is required" : 'must be "polygon" or "circle"');
  return undefined;
}

/** The larger side of the Chassis shape's bounding box (a circle's diameter). */
function largestDimension(shape: ChassisShape): number {
  if (shape.shape === "circle") return 2 * shape.radius;
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function withinChassis(p: Point, shape: ChassisShape): boolean {
  if (shape.shape === "circle") return p.x * p.x + p.y * p.y <= shape.radius * shape.radius;
  return pointInPolygon(p, shape.points);
}

function readSlot(r: Reader, ids: Map<string, string>, obj: Json, path: string): Slot | undefined {
  r.keys(obj, ["id", "type", "x", "y", "direction"], path);
  const id = r.string(obj, "id", path, NAME, NAME_RULE);
  if (id !== undefined) r.unique(ids, id, `${path}.id`);
  const type = r.string(obj, "type", path, NAME, NAME_RULE);
  const x = r.number(obj, "x", path);
  const y = r.number(obj, "y", path);
  let direction = r.number(obj, "direction", path);
  if (direction !== undefined && (direction <= -180 || direction > 180)) {
    r.error(`${path}.direction`, "must be in (-180, 180]");
    direction = undefined;
  }
  if (id === undefined || type === undefined || x === undefined || y === undefined || direction === undefined) {
    return undefined;
  }
  return { id, type, x, y, direction };
}

/** Reads stat values, checking them only for shape; checkStats checks them against declarations. */
function readStats(r: Reader, obj: Json, path: string): Stats | undefined {
  return r.named(obj, "stats", path, (v, statPath): StatValue | undefined => {
    if (typeof v === "number") {
      if (Number.isFinite(v)) return v;
    } else if (typeof v === "string") {
      return v;
    } else if (isRecord(v)) {
      const out: Record<string, TerrainMultipliers> = {};
      let valid = true;
      for (const [terrain, m] of Object.entries(v)) {
        if (!NAME.test(terrain)) {
          r.error(`${statPath}.${terrain}`, `has an invalid Terrain name: names ${NAME_RULE}`);
          valid = false;
          continue;
        }
        const multipliers = readMultipliers(r, m, `${statPath}.${terrain}`);
        if (multipliers === undefined) valid = false;
        else out[terrain] = multipliers;
      }
      return valid ? out : undefined;
    }
    r.error(statPath, "must be a finite number, a string or a Terrain modifiers object");
    return undefined;
  });
}

function readCatalogEntry(r: Reader, ids: Map<string, string>, obj: Json, path: string) {
  const id = r.string(obj, "id", path, ID, ID_RULE);
  if (id !== undefined) r.unique(ids, id, `${path}.id`);
  const name = r.string(obj, "name", path);
  const cost = r.whole(obj, "cost", path, 0);
  const stats = readStats(r, obj, path);
  const artwork = r.optionalString(obj, "artwork", path);
  if (id === undefined || name === undefined || cost === undefined || stats === undefined) return undefined;
  if (obj.artwork !== undefined && artwork === undefined) return undefined;
  return { id, name, cost, stats, ...(artwork === undefined ? {} : { artwork }) };
}

function readChassis(r: Reader, ids: Map<string, string>, obj: Json, path: string): Chassis | undefined {
  r.keys(obj, ["id", "name", "cost", "shape", "slots", "stats", "artwork"], path);
  const entry = readCatalogEntry(r, ids, obj, path);
  if (entry && entry.cost < 1) r.error(`${path}.cost`, "must be at least 1");
  const shape = readChassisShape(r, obj, path);
  const slotIds = new Map<string, string>();
  const slots = r.objects(obj, "slots", path, (v, p) => readSlot(r, slotIds, v, p));
  if (entry === undefined || entry.cost < 1 || shape === undefined || slots === undefined) return undefined;
  slots.forEach((slot, i) => {
    if (!withinChassis(slot, shape)) r.error(`${path}.slots[${String(i)}]`, "must lie within the Chassis shape");
  });
  return { ...entry, shape, slots };
}

function readVisualSize(r: Reader, obj: Json, path: string): VisualSize | undefined {
  const v = r.record(obj, "visualSize", path);
  if (v === undefined) return undefined;
  const sizePath = `${path}.visualSize`;
  r.keys(v, ["length", "width"], sizePath);
  const length = r.positive(v, "length", sizePath);
  const width = r.positive(v, "width", sizePath);
  return length === undefined || width === undefined ? undefined : { length, width };
}

function readComponent(r: Reader, ids: Map<string, string>, obj: Json, path: string): Component | undefined {
  r.keys(obj, ["id", "name", "kind", "cost", "slotTypes", "stats", "artwork", "visualSize"], path);
  const entry = readCatalogEntry(r, ids, obj, path);
  const kind = r.string(obj, "kind", path, NAME, NAME_RULE);
  let slotTypes: string[] | undefined = [];
  if (obj.slotTypes !== undefined) {
    const seen = new Map<string, string>();
    slotTypes = r.list(obj, "slotTypes", path, (v, p) => {
      if (typeof v !== "string" || !NAME.test(v)) {
        r.error(p, `must be a Slot type name: names ${NAME_RULE}`);
        return undefined;
      }
      r.unique(seen, v, p);
      return v;
    });
  }
  const visualSize = obj.visualSize === undefined ? undefined : readVisualSize(r, obj, path);
  if (entry === undefined || kind === undefined || slotTypes === undefined) return undefined;
  if (obj.visualSize !== undefined && visualSize === undefined) return undefined;
  return { ...entry, kind, slotTypes, ...(visualSize === undefined ? {} : { visualSize }) };
}

function checkStats(
  r: Reader,
  stats: Stats,
  defs: Readonly<Record<string, StatDefinition>>,
  terrains: ReadonlySet<string>,
  path: string,
): void {
  for (const name of Object.keys(stats)) {
    if (!Object.hasOwn(defs, name)) r.error(`${path}.stats.${name}`, "is not a declared stat");
  }
  for (const [name, def] of Object.entries(defs)) {
    const statPath = `${path}.stats.${name}`;
    if (!Object.hasOwn(stats, name)) {
      r.error(statPath, "is required");
      continue;
    }
    const v = stats[name];
    if (def.type === "number") {
      if (typeof v !== "number") r.error(statPath, "must be a number");
      else if (def.integer === true && !Number.isInteger(v)) r.error(statPath, "must be a whole number");
      else if (def.min !== undefined && v < def.min) r.error(statPath, `must be at least ${String(def.min)}`);
      else if (def.max !== undefined && v > def.max) r.error(statPath, `must be at most ${String(def.max)}`);
    } else if (def.type === "enum") {
      if (typeof v !== "string" || !def.values.includes(v)) {
        r.error(statPath, `must be one of ${def.values.map((s) => `"${s}"`).join(", ")}`);
      }
    } else if (typeof v !== "object") {
      r.error(statPath, "must be a Terrain modifiers object");
    } else {
      for (const terrain of Object.keys(v)) {
        if (!terrains.has(terrain)) r.error(`${statPath}.${terrain}`, `is the unknown Terrain "${terrain}"`);
      }
    }
  }
}

const ROOT_KEYS = [
  "version",
  "tickRate",
  "pointBudget",
  "mapFormats",
  "terrains",
  "limits",
  "slotTypes",
  "chassisStats",
  "componentKinds",
  "chassis",
  "components",
];

/** Validates a parsed JSON value as a Ruleset. */
export function validateRuleset(input: unknown): RulesetResult {
  const r = new Reader("Ruleset");
  if (!isRecord(input)) return { ok: false, errors: [{ path: "ruleset", message: "must be an object" }] };
  r.keys(input, ROOT_KEYS, "ruleset");

  const version = r.string(input, "version", "ruleset", ID, ID_RULE);
  const tickRate = r.whole(input, "tickRate", "ruleset", 1);

  let pointBudget: Ruleset["pointBudget"] | undefined;
  const budget = r.record(input, "pointBudget", "ruleset");
  if (budget) {
    r.keys(budget, ["min", "max"], "ruleset.pointBudget");
    const min = r.whole(budget, "min", "ruleset.pointBudget", 1);
    const max = r.whole(budget, "max", "ruleset.pointBudget", 1);
    if (min !== undefined && max !== undefined) {
      if (min > max) r.error("ruleset.pointBudget", "must have min at most max");
      else pointBudget = { min, max };
    }
  }

  const formats = new Map<string, string>();
  const mapFormats = r.list(input, "mapFormats", "ruleset", (v, p) => {
    if (typeof v !== "number" || !SUPPORTED_MAP_FORMATS.includes(v)) {
      r.error(p, `must be a supported Map Format (${SUPPORTED_MAP_FORMATS.join(", ")})`);
      return undefined;
    }
    r.unique(formats, String(v), p);
    return v;
  });
  if (mapFormats?.length === 0) r.error("ruleset.mapFormats", "must not be empty");

  const terrainNames = new Map<string, string>();
  const terrains = r.objects(input, "terrains", "ruleset", (v, p) => readTerrain(r, terrainNames, v, p));
  if (terrains?.length === 0) r.error("ruleset.terrains", "must not be empty");

  let limits: RulesetLimits | undefined;
  const limitsObj = r.record(input, "limits", "ruleset");
  if (limitsObj) {
    r.keys(limitsObj, LIMIT_KEYS, "ruleset.limits");
    const values = LIMIT_KEYS.map((key) => r.whole(limitsObj, key, "ruleset.limits", 1));
    if (values.every((v) => v !== undefined)) {
      limits = Object.fromEntries(LIMIT_KEYS.map((key, i) => [key, values[i]])) as unknown as RulesetLimits;
    }
  }

  const slotTypeNames = new Map<string, string>();
  const slotTypes = r.list(input, "slotTypes", "ruleset", (v, p) => {
    if (typeof v !== "string" || !NAME.test(v)) {
      r.error(p, `must be a Slot type name: names ${NAME_RULE}`);
      return undefined;
    }
    r.unique(slotTypeNames, v, p);
    return v;
  });

  const chassisStats = r.named(input, "chassisStats", "ruleset", (v, p) => readStatDefinition(r, v, p));
  const componentKinds = r.named(input, "componentKinds", "ruleset", (v, p) => readComponentKind(r, v, p));

  const ids = new Map<string, string>();
  const chassis = r.objects(input, "chassis", "ruleset", (v, p) => readChassis(r, ids, v, p));
  if (chassis?.length === 0) r.error("ruleset.chassis", "must not be empty");
  const components = r.objects(input, "components", "ruleset", (v, p) => readComponent(r, ids, v, p));

  if (
    r.errors.length > 0 ||
    version === undefined ||
    tickRate === undefined ||
    pointBudget === undefined ||
    mapFormats === undefined ||
    terrains === undefined ||
    limits === undefined ||
    slotTypes === undefined ||
    chassisStats === undefined ||
    componentKinds === undefined ||
    chassis === undefined ||
    components === undefined
  ) {
    return { ok: false, errors: r.errors };
  }

  const terrainSet = new Set(terrains.map((t) => t.name));
  const slotTypeSet = new Set(slotTypes);
  const largest = Math.max(...chassis.map((c) => largestDimension(c.shape)));
  chassis.forEach((c, i) => {
    const path = `ruleset.chassis[${String(i)}]`;
    c.slots.forEach((slot, j) => {
      if (!slotTypeSet.has(slot.type)) r.error(`${path}.slots[${String(j)}].type`, `is the unknown Slot type "${slot.type}"`);
    });
    checkStats(r, c.stats, chassisStats, terrainSet, path);
  });
  components.forEach((c, i) => {
    const path = `ruleset.components[${String(i)}]`;
    const kind = Object.hasOwn(componentKinds, c.kind) ? componentKinds[c.kind] : undefined;
    if (kind === undefined) {
      r.error(`${path}.kind`, `is the unknown Component kind "${c.kind}"`);
      return;
    }
    if (kind.mount === "slot" && c.slotTypes.length === 0) {
      r.error(`${path}.slotTypes`, `is required for "${c.kind}" Components and must not be empty`);
    }
    if (kind.mount === "side" && c.slotTypes.length > 0) {
      r.error(`${path}.slotTypes`, `is not allowed on side-mounted "${c.kind}" Components`);
    }
    c.slotTypes.forEach((type, j) => {
      if (!slotTypeSet.has(type)) r.error(`${path}.slotTypes[${String(j)}]`, `is the unknown Slot type "${type}"`);
    });
    checkStats(r, c.stats, kind.stats, terrainSet, path);
    if (c.visualSize !== undefined) {
      if (kind.mount === "side") {
        r.error(`${path}.visualSize`, `is not allowed on side-mounted "${c.kind}" Components`);
      }
      for (const key of ["length", "width"] as const) {
        if (c.visualSize[key] > largest) {
          r.error(`${path}.visualSize.${key}`, `must be at most the largest Chassis dimension (${String(largest)} m)`);
        }
      }
    }
  });

  const cheapest = Math.min(...chassis.map((c) => c.cost));
  if (pointBudget.min < cheapest) {
    r.error("ruleset.pointBudget.min", `must be at least the cheapest Chassis cost (${String(cheapest)})`);
  }

  if (r.errors.length > 0) return { ok: false, errors: r.errors };
  return {
    ok: true,
    ruleset: {
      version,
      tickRate,
      pointBudget,
      mapFormats,
      terrains,
      limits,
      slotTypes,
      chassisStats,
      componentKinds,
      chassis,
      components,
    },
  };
}

/** Parses JSON text and validates it as a Ruleset. */
export function parseRuleset(json: string): RulesetResult {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: "ruleset", message: `is not valid JSON: ${(e as Error).message}` }] };
  }
  return validateRuleset(input);
}

/** The Ruleset's Terrain names, for checkMapTerrains. */
export function terrainNames(ruleset: Ruleset): ReadonlySet<string> {
  return new Set(ruleset.terrains.map((t) => t.name));
}

/** A Build: one Chassis, Components by Slot id, and an optional Armor Component per side. */
export interface Build {
  readonly chassis: string;
  /** Slot id to Component id; empty Slots are omitted. */
  readonly components: Readonly<Record<string, string>>;
  readonly armor: Readonly<Record<ArmorSide, string | null>>;
}

export type BuildResult =
  | { readonly ok: true; readonly build: Build; readonly cost: number }
  | { readonly ok: false; readonly errors: readonly RulesetError[] };

/**
 * Validates a parsed JSON value as a Build under the Ruleset: every part
 * exists, every Component fits its Slot's type, and Armor sides hold only
 * side-mounted Components. On success it reports the Build's point cost.
 */
export function validateBuild(ruleset: Ruleset, input: unknown): BuildResult {
  const r = new Reader("Build");
  if (!isRecord(input)) return { ok: false, errors: [{ path: "build", message: "must be an object" }] };
  r.keys(input, ["chassis", "components", "armor"], "build");

  const componentsById = new Map(ruleset.components.map((c) => [c.id, c]));
  const findComponent = (v: unknown, path: string): Component | undefined => {
    if (typeof v !== "string") {
      r.error(path, "must be a Component id");
      return undefined;
    }
    const component = componentsById.get(v);
    if (component === undefined) r.error(path, `is the unknown Component "${v}"`);
    return component;
  };

  let cost = 0;
  let chassis: Chassis | undefined;
  const chassisId = r.string(input, "chassis", "build");
  if (chassisId !== undefined) {
    chassis = ruleset.chassis.find((c) => c.id === chassisId);
    if (chassis === undefined) r.error("build.chassis", `is the unknown Chassis "${chassisId}"`);
    else cost += chassis.cost;
  }

  const components: Record<string, string> = {};
  const installed = r.record(input, "components", "build");
  if (installed !== undefined && chassis !== undefined) {
    for (const [slotId, componentId] of Object.entries(installed)) {
      const path = `build.components.${slotId}`;
      const slot = chassis.slots.find((s) => s.id === slotId);
      if (slot === undefined) {
        r.error(path, `is not a Slot of Chassis "${chassis.id}"`);
        continue;
      }
      const component = findComponent(componentId, path);
      if (component === undefined) continue;
      if (!component.slotTypes.includes(slot.type)) {
        r.error(path, `"${component.id}" does not fit the ${slot.type} Slot "${slot.id}"`);
        continue;
      }
      components[slotId] = component.id;
      cost += component.cost;
    }
  }

  const armor: Partial<Record<ArmorSide, string | null>> = {};
  const sides = r.record(input, "armor", "build");
  if (sides !== undefined) {
    r.keys(sides, ARMOR_SIDES, "build.armor");
    for (const side of ARMOR_SIDES) {
      const path = `build.armor.${side}`;
      const v = sides[side];
      if (v === undefined) {
        r.error(path, "is required (null for none)");
        continue;
      }
      if (v === null) {
        armor[side] = null;
        continue;
      }
      const component = findComponent(v, path);
      if (component === undefined) continue;
      if (ruleset.componentKinds[component.kind]?.mount !== "side") {
        r.error(path, `"${component.id}" is not side-mounted Armor`);
        continue;
      }
      armor[side] = component.id;
      cost += component.cost;
    }
  }

  if (r.errors.length > 0 || chassis === undefined) return { ok: false, errors: r.errors };
  return { ok: true, build: { chassis: chassis.id, components, armor: armor as Build["armor"] }, cost };
}

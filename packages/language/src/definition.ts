/**
 * What a Ruleset's language provides to Programs (ADR-0004): its built-in
 * functions, its read-only built-in values (`self`, `game`, `map`) and the
 * list and string methods. The checker validates a Program against one of
 * these; the interpreter takes built-in costs from it.
 */

/** The static shape of a built-in value, used to check direct field reads. */
export type ValueType =
  | "number"
  | "string"
  | "boolean"
  /** Any value; nothing more is known statically. */
  | "any"
  | { readonly record: Readonly<Record<string, ValueType>> }
  | { readonly list: ValueType }
  /** A record keyed by data (such as Terrain names) whose fields all share one type. */
  | { readonly map: ValueType };

export interface BuiltinFunction {
  readonly minArgs: number;
  readonly maxArgs: number;
  /** Operations charged in place of the call node (language-r1 section 8.2). */
  readonly cost: number;
  /** False for commands and sensors, which the init phase may not call. */
  readonly initPhase: boolean;
  /** The first argument names a Slot holding this kind of Component. */
  readonly slotArgument?: "weapon" | "rangefinder";
  /** Mutates its first argument, so it may not be given a read-only value. */
  readonly mutatesFirstArgument?: boolean;
}

export interface BuiltinMethod {
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly cost: number;
  /** Mutates the receiver, so it may not be called on a read-only value. */
  readonly mutates?: boolean;
}

export interface LanguageDefinition {
  /** The Ruleset version whose language this is. */
  readonly version: string;
  readonly functions: Readonly<Record<string, BuiltinFunction>>;
  readonly values: Readonly<Record<string, ValueType>>;
  readonly listMethods: Readonly<Record<string, BuiltinMethod>>;
  readonly stringMethods: Readonly<Record<string, BuiltinMethod>>;
  /** Cost of reading `.length` on a list or string, in place of the member access. */
  readonly lengthCost: number;
}

/** Looks up an own entry, so names such as `toString` never hit Object.prototype. */
export function lookup<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

function fn(args: number | readonly [number, number], cost: number, extra: Partial<BuiltinFunction> = {}): BuiltinFunction {
  const [minArgs, maxArgs] = typeof args === "number" ? [args, args] : args;
  return { minArgs, maxArgs, cost, initPhase: true, ...extra };
}

function method(args: number | readonly [number, number], cost: number, mutates = false): BuiltinMethod {
  const [minArgs, maxArgs] = typeof args === "number" ? [args, args] : args;
  return mutates ? { minArgs, maxArgs, cost, mutates } : { minArgs, maxArgs, cost };
}

const tickOnly = { initPhase: false } as const;

const point: ValueType = { record: { x: "number", y: "number" } };

/** Region, Obstacle and spawn zone geometry: `points` for polygons, `x, y, radius` for circles. */
const geometry = { shape: "string", points: { list: point }, x: "number", y: "number", radius: "number" } as const;

/** The language of Ruleset r1 (language-r1 sections 6 and 7). */
export const R1_LANGUAGE: LanguageDefinition = {
  version: "r1",
  functions: {
    throttle: fn(1, 2, tickOnly),
    turn: fn(1, 2, tickOnly),
    fire: fn(2, 5, { ...tickOnly, slotArgument: "weapon" }),
    fireAbs: fn(2, 5, { ...tickOnly, slotArgument: "weapon" }),
    scan: fn(0, 15, tickOnly),
    rangefind: fn(1, 8, { ...tickOnly, slotArgument: "rangefinder" }),
    incoming: fn(0, 8, tickOnly),
    terrainHere: fn(0, 2),
    terrainAt: fn(2, 4),
    checkTerrain: fn(2, 5),
    terrainTable: fn(0, 4),
    sin: fn(1, 3),
    cos: fn(1, 3),
    tan: fn(1, 3),
    asin: fn(1, 3),
    acos: fn(1, 3),
    atan2: fn(2, 3),
    sqrt: fn(1, 3),
    hypot: fn(2, 3),
    abs: fn(1, 1),
    min: fn(2, 1),
    max: fn(2, 1),
    clamp: fn(3, 1),
    floor: fn(1, 1),
    ceil: fn(1, 1),
    round: fn(1, 1),
    normalizeAngle: fn(1, 1),
    bearingTo: fn(2, 4),
    absBearingTo: fn(2, 4),
    distanceTo: fn(2, 4),
    random: fn(0, 2),
    keys: fn(1, 3),
    has: fn(2, 1),
    remove: fn(2, 1, { mutatesFirstArgument: true }),
    str: fn(1, 2),
    log: fn(1, 2),
    budgetRemaining: fn(0, 1),
  },
  values: {
    self: {
      record: {
        name: "string",
        tick: "number",
        x: "number",
        y: "number",
        heading: "number",
        speed: "number",
        turnRate: "number",
        throttle: "number",
        turn: "number",
        hitPoints: "number",
        maxHitPoints: "number",
        mass: "number",
        armor: { record: { front: "number", left: "number", right: "number", rear: "number" } },
        weapons: {
          list: {
            record: {
              id: "string",
              category: "string",
              arcWidth: "number",
              range: "number",
              reloadTicks: "number",
              ticksUntilReady: "number",
            },
          },
        },
        sensors: { list: { record: { id: "string", kind: "string", arcWidth: "number", range: "number" } } },
        motorTerrain: { map: { record: { speed: "number", accel: "number" } } },
      },
    },
    game: { record: { tickRate: "number", timeLimitTicks: "number", playerCount: "number" } },
    map: {
      record: {
        width: "number",
        height: "number",
        baseTerrain: "string",
        terrainRegions: { list: { record: { terrain: "string", ...geometry } } },
        obstacles: { list: { record: { id: "string", destructible: "boolean", ...geometry } } },
        spawnZones: { list: { record: { heading: "number", capacity: "number", ...geometry } } },
      },
    },
  },
  listMethods: {
    push: method(1, 1, true),
    pop: method(0, 1, true),
    slice: method([1, 2], 3),
    indexOf: method(1, 3),
    includes: method(1, 3),
    join: method(1, 3),
    map: method(1, 3),
    filter: method(1, 3),
    find: method(1, 3),
    some: method(1, 3),
    every: method(1, 3),
    reduce: method(2, 3),
    sort: method(1, 5, true),
  },
  stringMethods: {
    slice: method([1, 2], 3),
    indexOf: method(1, 3),
    includes: method(1, 3),
  },
  lengthCost: 1,
};

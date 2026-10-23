/**
 * Map Format 1 (spec section 6).
 *
 * A Map is a rectangle [0, width] x [0, height] in meters, origin top-left,
 * y down. Every feature carries its geometry flattened next to its own
 * fields, as Programs see it in `map.*` (language-r1 section 6.3):
 * `shape: "polygon"` with `points`, or `shape: "circle"` with `x, y, radius`.
 *
 * Map Formats are independent of Rulesets, so Terrain names are only checked
 * for shape here; checkMapTerrains checks them against a Ruleset's table.
 *
 * Validation is strict (unknown fields are errors) and reports every problem
 * it finds, each with a path such as `map.obstacles[2].hitPoints`. Geometric
 * checks run only once the structure is valid:
 *
 * - every feature lies within the Map bounds;
 * - polygons are simple and not degenerate;
 * - Spawn Zones do not touch or overlap Obstacles or each other.
 */

import {
  isSimplePolygon,
  polygonArea2,
  shapesOverlap,
  shapeWithinBounds,
  type Point,
  type Shape,
} from "./geometry.js";

export type { Circle, Point, Polygon, Shape } from "./geometry.js";

export type TerrainRegion = { readonly terrain: string } & Shape;

export type Obstacle = { readonly id: string } & (
  | { readonly destructible: false }
  | { readonly destructible: true; readonly hitPoints: number }
) &
  Shape;

export type SpawnZone = {
  /** Absolute starting Heading for the Bots placed here, in [0, 360). */
  readonly heading: number;
  /** The most Bots one Entry may place in this zone. */
  readonly capacity: number;
} & Shape;

export interface MapFormat1 {
  readonly format: 1;
  readonly width: number;
  readonly height: number;
  readonly baseTerrain: string;
  /** In listed order; the later one wins on overlap. */
  readonly terrainRegions: readonly TerrainRegion[];
  readonly obstacles: readonly Obstacle[];
  /** One per supported Player. */
  readonly spawnZones: readonly SpawnZone[];
}

/** Server-configured size limits; any omitted limit is unbounded. */
export interface MapLimits {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxPolygonPoints?: number;
  /** Combined count of Terrain Regions, Obstacles and Spawn Zones. */
  readonly maxFeatures?: number;
}

export interface MapError {
  readonly path: string;
  readonly message: string;
}

export type MapResult =
  | { readonly ok: true; readonly map: MapFormat1 }
  | { readonly ok: false; readonly errors: readonly MapError[] };

export const MIN_SPAWN_ZONES = 2;

// Obstacle ids exclude ":" so the engine can name wreck Obstacles without clashing.
const OBSTACLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Reader {
  readonly errors: MapError[] = [];

  constructor(readonly limits: MapLimits) {}

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  keys(obj: Json, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.error(`${path}.${key}`, "is not a Map Format 1 field");
    }
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

  terrain(obj: Json, key: string, path: string): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      this.error(`${path}.${key}`, "is required");
      return undefined;
    }
    if (typeof v !== "string" || v === "") {
      this.error(`${path}.${key}`, "must be a non-empty Terrain name");
      return undefined;
    }
    return v;
  }

  list<T>(obj: Json, key: string, path: string, item: (v: Json, path: string) => T | undefined): T[] {
    const v = obj[key];
    const listPath = `${path}.${key}`;
    if (v === undefined) {
      this.error(listPath, "is required");
      return [];
    }
    if (!Array.isArray(v)) {
      this.error(listPath, "must be a list");
      return [];
    }
    const out: T[] = [];
    v.forEach((element: unknown, i) => {
      const itemPath = `${listPath}[${String(i)}]`;
      if (!isRecord(element)) {
        this.error(itemPath, "must be an object");
        return;
      }
      const parsed = item(element, itemPath);
      if (parsed !== undefined) out.push(parsed);
    });
    return out;
  }

  /** Reads the geometry of a feature whose own fields are `ownKeys`. */
  shape(obj: Json, path: string, ownKeys: readonly string[]): Shape | undefined {
    const kind = obj.shape;
    if (kind === "circle") {
      this.keys(obj, [...ownKeys, "shape", "x", "y", "radius"], path);
      const x = this.number(obj, "x", path);
      const y = this.number(obj, "y", path);
      const radius = this.positive(obj, "radius", path);
      if (x === undefined || y === undefined || radius === undefined) return undefined;
      return { shape: "circle", x, y, radius };
    }
    if (kind === "polygon") {
      this.keys(obj, [...ownKeys, "shape", "points"], path);
      const points = this.points(obj, `${path}.points`);
      return points && { shape: "polygon", points };
    }
    this.error(`${path}.shape`, kind === undefined ? "is required" : 'must be "polygon" or "circle"');
    return undefined;
  }

  private points(obj: Json, path: string): Point[] | undefined {
    const v = obj.points;
    if (v === undefined) {
      this.error(path, "is required");
      return undefined;
    }
    if (!Array.isArray(v)) {
      this.error(path, "must be a list of {x, y} points");
      return undefined;
    }
    if (v.length < 3) {
      this.error(path, "must have at least 3 points");
      return undefined;
    }
    const max = this.limits.maxPolygonPoints;
    if (max !== undefined && v.length > max) {
      this.error(path, `must have at most ${String(max)} points`);
      return undefined;
    }
    const points: Point[] = [];
    v.forEach((element: unknown, i) => {
      const pointPath = `${path}[${String(i)}]`;
      if (!isRecord(element)) {
        this.error(pointPath, "must be an {x, y} point");
        return;
      }
      this.keys(element, ["x", "y"], pointPath);
      const x = this.number(element, "x", pointPath);
      const y = this.number(element, "y", pointPath);
      if (x !== undefined && y !== undefined) points.push({ x, y });
    });
    if (points.length !== v.length) return undefined;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a && b && a.x === b.x && a.y === b.y) {
        this.error(`${path}[${String((i + 1) % points.length)}]`, "repeats the previous point");
        return undefined;
      }
    }
    if (polygonArea2(points) === 0) {
      this.error(path, "must enclose a non-zero area");
      return undefined;
    }
    if (!isSimplePolygon(points)) {
      this.error(path, "must not cross or touch itself");
      return undefined;
    }
    return points;
  }
}

function readTerrainRegion(r: Reader, obj: Json, path: string): TerrainRegion | undefined {
  const terrain = r.terrain(obj, "terrain", path);
  const shape = r.shape(obj, path, ["terrain"]);
  return terrain === undefined || shape === undefined ? undefined : { terrain, ...shape };
}

function readObstacle(r: Reader, ids: Map<string, string>, obj: Json, path: string): Obstacle | undefined {
  let id: string | undefined;
  if (obj.id === undefined) r.error(`${path}.id`, "is required");
  else if (typeof obj.id !== "string" || !OBSTACLE_ID.test(obj.id)) {
    r.error(`${path}.id`, "must be 1-64 letters, digits, '-' or '_'");
  } else {
    const first = ids.get(obj.id);
    if (first === undefined) ids.set(obj.id, path);
    else r.error(`${path}.id`, `duplicates ${first}.id "${obj.id}"`);
    id = obj.id;
  }

  const destructible = obj.destructible;
  if (typeof destructible !== "boolean") {
    r.error(`${path}.destructible`, destructible === undefined ? "is required" : "must be true or false");
  }
  let hitPoints: number | undefined;
  if (destructible === true) hitPoints = r.positive(obj, "hitPoints", path);
  else if (destructible === false && obj.hitPoints !== undefined) {
    r.error(`${path}.hitPoints`, "is only allowed on destructible Obstacles");
  }

  const shape = r.shape(obj, path, ["id", "destructible", "hitPoints"]);
  if (id === undefined || shape === undefined) return undefined;
  if (destructible === true && hitPoints !== undefined) return { id, destructible, hitPoints, ...shape };
  if (destructible === false) return { id, destructible, ...shape };
  return undefined;
}

function readSpawnZone(r: Reader, obj: Json, path: string): SpawnZone | undefined {
  let heading = r.number(obj, "heading", path);
  if (heading !== undefined && (heading < 0 || heading >= 360)) {
    r.error(`${path}.heading`, "must be in [0, 360)");
    heading = undefined;
  }
  let capacity = r.number(obj, "capacity", path);
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) {
    r.error(`${path}.capacity`, "must be a whole number of at least 1");
    capacity = undefined;
  }
  const shape = r.shape(obj, path, ["heading", "capacity"]);
  if (heading === undefined || capacity === undefined || shape === undefined) return undefined;
  return { heading, capacity, ...shape };
}

const ROOT_KEYS = ["format", "width", "height", "baseTerrain", "terrainRegions", "obstacles", "spawnZones"];

/** Validates a parsed JSON value as a Map Format 1 Map. */
export function validateMap(input: unknown, limits: MapLimits = {}): MapResult {
  const r = new Reader(limits);
  if (!isRecord(input)) return { ok: false, errors: [{ path: "map", message: "must be an object" }] };
  r.keys(input, ROOT_KEYS, "map");

  if (input.format !== 1) {
    r.error("map.format", input.format === undefined ? "is required" : "must be 1 (Map Format 1)");
  }
  let width = r.positive(input, "width", "map");
  if (width !== undefined && limits.maxWidth !== undefined && width > limits.maxWidth) {
    r.error("map.width", `must be at most ${String(limits.maxWidth)}`);
    width = undefined;
  }
  let height = r.positive(input, "height", "map");
  if (height !== undefined && limits.maxHeight !== undefined && height > limits.maxHeight) {
    r.error("map.height", `must be at most ${String(limits.maxHeight)}`);
    height = undefined;
  }
  const baseTerrain = r.terrain(input, "baseTerrain", "map");
  const terrainRegions = r.list(input, "terrainRegions", "map", (v, p) => readTerrainRegion(r, v, p));
  const obstacleIds = new Map<string, string>();
  const obstacles = r.list(input, "obstacles", "map", (v, p) => readObstacle(r, obstacleIds, v, p));
  const spawnZones = r.list(input, "spawnZones", "map", (v, p) => readSpawnZone(r, v, p));

  if (Array.isArray(input.spawnZones) && input.spawnZones.length < MIN_SPAWN_ZONES) {
    r.error("map.spawnZones", `must have at least ${String(MIN_SPAWN_ZONES)} Spawn Zones`);
  }
  const features = terrainRegions.length + obstacles.length + spawnZones.length;
  if (limits.maxFeatures !== undefined && features > limits.maxFeatures) {
    r.error("map", `must have at most ${String(limits.maxFeatures)} Terrain Regions, Obstacles and Spawn Zones combined`);
  }

  if (r.errors.length > 0 || width === undefined || height === undefined || baseTerrain === undefined) {
    return { ok: false, errors: r.errors };
  }

  const groups = [
    ["terrainRegions", terrainRegions],
    ["obstacles", obstacles],
    ["spawnZones", spawnZones],
  ] as const;
  for (const [key, list] of groups) {
    list.forEach((s, i) => {
      if (!shapeWithinBounds(s, width, height)) {
        r.error(`map.${key}[${String(i)}]`, `must lie within the Map bounds (${String(width)} x ${String(height)})`);
      }
    });
  }
  spawnZones.forEach((zone, i) => {
    obstacles.forEach((o, j) => {
      if (shapesOverlap(zone, o)) {
        r.error(`map.spawnZones[${String(i)}]`, `touches or overlaps map.obstacles[${String(j)}] "${o.id}"`);
      }
    });
    spawnZones.slice(0, i).forEach((other, j) => {
      if (shapesOverlap(zone, other)) {
        r.error(`map.spawnZones[${String(i)}]`, `touches or overlaps map.spawnZones[${String(j)}]`);
      }
    });
  });
  if (r.errors.length > 0) return { ok: false, errors: r.errors };

  return { ok: true, map: { format: 1, width, height, baseTerrain, terrainRegions, obstacles, spawnZones } };
}

/** Parses JSON text and validates it as a Map Format 1 Map. */
export function parseMap(json: string, limits: MapLimits = {}): MapResult {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: "map", message: `is not valid JSON: ${(e as Error).message}` }] };
  }
  return validateMap(input, limits);
}

/** Reports every Terrain name in the Map that the given Ruleset Terrain table does not define. */
export function checkMapTerrains(map: MapFormat1, terrains: ReadonlySet<string>): MapError[] {
  const errors: MapError[] = [];
  const unknown = (path: string, name: string) => {
    if (!terrains.has(name)) errors.push({ path, message: `is the unknown Terrain "${name}"` });
  };
  unknown("map.baseTerrain", map.baseTerrain);
  map.terrainRegions.forEach((region, i) => {
    unknown(`map.terrainRegions[${String(i)}].terrain`, region.terrain);
  });
  return errors;
}

/** Whether an Entry of `botCount` Bots fits the Spawn Zone's capacity. */
export function entryFitsSpawnZone(zone: SpawnZone, botCount: number): boolean {
  return botCount >= 1 && botCount <= zone.capacity;
}

/** Whether an Entry of `botCount` Bots fits at least one of the Map's Spawn Zones. */
export function entryFitsMap(map: MapFormat1, botCount: number): boolean {
  return map.spawnZones.some((zone) => entryFitsSpawnZone(zone, botCount));
}

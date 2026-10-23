import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkMapTerrains,
  entryFitsMap,
  entryFitsSpawnZone,
  parseMap,
  validateMap,
  type MapError,
  type MapFormat1,
  type MapLimits,
} from "./map-format-1.js";

function sample(name: string): string {
  return readFileSync(new URL(`../maps/${name}.json`, import.meta.url), "utf8");
}

const square = (x: number, y: number, size: number) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

function base(): Record<string, unknown> {
  return {
    format: 1,
    width: 100,
    height: 50,
    baseTerrain: "grass",
    terrainRegions: [],
    obstacles: [],
    spawnZones: [
      { heading: 90, capacity: 2, shape: "circle", x: 10, y: 25, radius: 5 },
      { heading: 270, capacity: 3, shape: "polygon", points: square(80, 20, 10) },
    ],
  };
}

function errorsOf(input: unknown, limits?: MapLimits): readonly MapError[] {
  const result = validateMap(input, limits);
  if (result.ok) throw new Error("expected the Map to be invalid");
  return result.errors;
}

function valid(input: unknown): MapFormat1 {
  const result = validateMap(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.map;
}

describe("sample Maps", () => {
  it.each(["duel", "four-corners"])("%s loads", (name) => {
    const result = parseMap(sample(name));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("keeps feature fields and order", () => {
    const result = parseMap(sample("duel"));
    if (!result.ok) throw new Error("duel should load");
    expect(result.map.terrainRegions.map((r) => r.terrain)).toEqual(["road", "sand"]);
    expect(result.map.obstacles[1]).toMatchObject({ id: "crate-north", destructible: true, hitPoints: 150 });
    expect(result.map.spawnZones).toHaveLength(2);
  });
});

describe("structural errors", () => {
  it("rejects invalid JSON", () => {
    const result = parseMap("{ nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/^is not valid JSON/);
  });

  it("rejects a non-object", () => {
    expect(errorsOf([])).toEqual([{ path: "map", message: "must be an object" }]);
  });

  it("reports every missing top-level field", () => {
    expect(errorsOf({}).map((e) => e.path)).toEqual([
      "map.format",
      "map.width",
      "map.height",
      "map.baseTerrain",
      "map.terrainRegions",
      "map.obstacles",
      "map.spawnZones",
    ]);
  });

  it("rejects an unknown format and unknown fields", () => {
    expect(errorsOf({ ...base(), format: 2, colour: "red" })).toEqual([
      { path: "map.colour", message: "is not a Map Format 1 field" },
      { path: "map.format", message: "must be 1 (Map Format 1)" },
    ]);
  });

  it("rejects non-positive and non-finite dimensions", () => {
    expect(errorsOf({ ...base(), width: 0, height: "50" })).toEqual([
      { path: "map.width", message: "must be greater than 0" },
      { path: "map.height", message: "must be a finite number" },
    ]);
  });

  it("applies size limits", () => {
    const errors = errorsOf(base(), { maxWidth: 99, maxHeight: 49, maxFeatures: 1 });
    expect(errors.map((e) => e.path)).toEqual(["map.width", "map.height", "map"]);
  });

  it("rejects bad shapes with paths", () => {
    const errors = errorsOf({
      ...base(),
      terrainRegions: [
        { terrain: "sand", shape: "square", x: 1 },
        { terrain: "", shape: "circle", x: 5, y: 5, radius: -1, points: [] },
        { terrain: "sand", shape: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      ],
    });
    expect(errors).toEqual([
      { path: "map.terrainRegions[0].shape", message: 'must be "polygon" or "circle"' },
      { path: "map.terrainRegions[1].terrain", message: "must be a non-empty Terrain name" },
      { path: "map.terrainRegions[1].points", message: "is not a Map Format 1 field" },
      { path: "map.terrainRegions[1].radius", message: "must be greater than 0" },
      { path: "map.terrainRegions[2].points", message: "must have at least 3 points" },
    ]);
  });

  it("rejects degenerate and self-intersecting polygons", () => {
    const region = (points: unknown) => ({ terrain: "sand", shape: "polygon", points });
    const errors = errorsOf({
      ...base(),
      terrainRegions: [
        region([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }]),
        region([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 6 }]),
        region([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]),
        region([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]),
        region([{ x: 0, y: 0, z: 1 }, { x: 1, y: "0" }, 3]),
      ],
      obstacles: [],
    });
    expect(errors).toEqual([
      { path: "map.terrainRegions[0].points", message: "must enclose a non-zero area" },
      { path: "map.terrainRegions[1].points", message: "must not cross or touch itself" },
      { path: "map.terrainRegions[2].points[2]", message: "repeats the previous point" },
      { path: "map.terrainRegions[3].points", message: "must not cross or touch itself" },
      { path: "map.terrainRegions[4].points[0].z", message: "is not a Map Format 1 field" },
      { path: "map.terrainRegions[4].points[1].y", message: "must be a finite number" },
      { path: "map.terrainRegions[4].points[2]", message: "must be an {x, y} point" },
    ]);
  });

  it("checks Obstacle ids and Hit Points", () => {
    const circle = { shape: "circle", x: 50, y: 25, radius: 1 };
    const errors = errorsOf({
      ...base(),
      obstacles: [
        { id: "a", destructible: false, hitPoints: 5, ...circle },
        { id: "b", destructible: true, ...circle },
        { id: "wreck:x", destructible: "yes", ...circle },
        { id: "a", destructible: true, hitPoints: 10, ...circle },
      ],
    });
    expect(errors).toEqual([
      { path: "map.obstacles[0].hitPoints", message: "is only allowed on destructible Obstacles" },
      { path: "map.obstacles[1].hitPoints", message: "is required" },
      { path: "map.obstacles[2].id", message: "must be 1-64 letters, digits, '-' or '_'" },
      { path: "map.obstacles[2].destructible", message: "must be true or false" },
      { path: "map.obstacles[3].id", message: 'duplicates map.obstacles[0].id "a"' },
    ]);
  });

  it("checks Spawn Zone Heading, capacity and count", () => {
    const circle = { shape: "circle", x: 50, y: 25, radius: 1 };
    expect(errorsOf({ ...base(), spawnZones: [{ heading: 360, capacity: 1.5, ...circle }] })).toEqual([
      { path: "map.spawnZones[0].heading", message: "must be in [0, 360)" },
      { path: "map.spawnZones[0].capacity", message: "must be a whole number of at least 1" },
      { path: "map.spawnZones", message: "must have at least 2 Spawn Zones" },
    ]);
  });
});

describe("geometric errors", () => {
  it("requires every feature inside the bounds", () => {
    const errors = errorsOf({
      ...base(),
      terrainRegions: [{ terrain: "sand", shape: "polygon", points: square(95, 0, 10) }],
      obstacles: [{ id: "edge", destructible: false, shape: "circle", x: 50, y: 1, radius: 2 }],
    });
    expect(errors.map((e) => e.path)).toEqual(["map.terrainRegions[0]", "map.obstacles[0]"]);
  });

  it("allows features touching the boundary", () => {
    valid({ ...base(), obstacles: [{ id: "wall", destructible: false, shape: "polygon", points: square(40, 0, 10) }] });
  });

  it("rejects Spawn Zones touching Obstacles or each other", () => {
    const errors = errorsOf({
      ...base(),
      obstacles: [
        { id: "inside", destructible: false, shape: "circle", x: 10, y: 25, radius: 1 },
        { id: "touching", destructible: false, shape: "polygon", points: square(70, 20, 10) },
        { id: "clear", destructible: false, shape: "circle", x: 50, y: 25, radius: 3 },
      ],
      spawnZones: [
        ...(base().spawnZones as unknown[]),
        { heading: 0, capacity: 1, shape: "polygon", points: square(84, 24, 2) },
      ],
    });
    expect(errors).toEqual([
      { path: "map.spawnZones[0]", message: 'touches or overlaps map.obstacles[0] "inside"' },
      { path: "map.spawnZones[1]", message: 'touches or overlaps map.obstacles[1] "touching"' },
      { path: "map.spawnZones[2]", message: "touches or overlaps map.spawnZones[1]" },
    ]);
  });

  it("allows Terrain Regions and Obstacles to overlap anything else", () => {
    valid({
      ...base(),
      terrainRegions: [{ terrain: "sand", shape: "circle", x: 10, y: 25, radius: 8 }],
      obstacles: [
        { id: "a", destructible: false, shape: "circle", x: 50, y: 25, radius: 5 },
        { id: "b", destructible: false, shape: "circle", x: 52, y: 25, radius: 5 },
      ],
    });
  });
});

describe("Ruleset and Entry checks", () => {
  it("reports Terrain names the Ruleset does not define", () => {
    const map = valid({ ...base(), terrainRegions: [{ terrain: "lava", shape: "circle", x: 50, y: 25, radius: 5 }] });
    expect(checkMapTerrains(map, new Set(["grass", "sand"]))).toEqual([
      { path: "map.terrainRegions[0].terrain", message: 'is the unknown Terrain "lava"' },
    ]);
    expect(checkMapTerrains(map, new Set(["grass", "lava"]))).toEqual([]);
  });

  it("checks whether an Entry fits a Spawn Zone", () => {
    const map = valid(base());
    const [small, large] = map.spawnZones;
    if (!small || !large) throw new Error("expected two Spawn Zones");
    expect(entryFitsSpawnZone(small, 2)).toBe(true);
    expect(entryFitsSpawnZone(small, 3)).toBe(false);
    expect(entryFitsSpawnZone(small, 0)).toBe(false);
    expect(entryFitsMap(map, 3)).toBe(true);
    expect(entryFitsMap(map, 4)).toBe(false);
  });
});

/**
 * Terrain lookup on a Map Format 1 Map (spec section 6).
 */

import type { MapFormat1, TerrainRegion } from "@aumohta/ruleset-data";
import { pointInShape, type Point, type WorldShape } from "./geometry.js";

function regionShape(region: TerrainRegion): WorldShape {
  return region.shape === "circle"
    ? { shape: "circle", x: region.x, y: region.y, radius: region.radius }
    : { shape: "polygon", points: region.points };
}

/**
 * The Terrain name at a point: the last-listed Terrain Region containing it
 * (boundaries included), or the Base Terrain. The caller checks that the
 * point is on the Map.
 */
export function terrainAt(map: MapFormat1, p: Point): string {
  for (let i = map.terrainRegions.length - 1; i >= 0; i--) {
    const region = map.terrainRegions[i];
    if (region !== undefined && pointInShape(p, regionShape(region))) return region.terrain;
  }
  return map.baseTerrain;
}

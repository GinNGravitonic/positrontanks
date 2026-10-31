/**
 * Drawing a Map (Map Format 1) on a canvas: its base Terrain and Terrain
 * Regions in listed order (the later one on top, as it wins on overlap),
 * Obstacles (destructible ones in their own color), Spawn Zones in the color
 * of the Player who would spawn there, each with an arrow along its Heading,
 * and the boundary. Line widths are in CSS pixels whatever the scale.
 */

import type { MapFormat1, Shape } from "@positrontanks/ruleset-data";
import { BOUNDARY_COLOR, DESTRUCTIBLE_COLOR, entryColor, OBSTACLE_COLOR, terrainColor } from "./colors.js";
import { traceShape, transform, type Context } from "./context.js";
import { poseMatrix, shapeBounds, viewMatrix, type Bounds, type View } from "./geometry.js";

export interface MapDrawOptions {
  /** Whether to draw Spawn Zones; true by default. The viewer leaves them out. */
  readonly spawnZones?: boolean;
}

/** All of the Map: [0, width] x [0, height]. */
export function mapBounds(map: MapFormat1): Bounds {
  return { minX: 0, minY: 0, maxX: map.width, maxY: map.height };
}

export function drawMap(ctx: Context, view: View, map: MapFormat1, options: MapDrawOptions = {}): void {
  const px = 1 / view.scale;
  ctx.save();
  transform(ctx, viewMatrix(view));
  ctx.lineJoin = "round";

  ctx.fillStyle = terrainColor(map.baseTerrain);
  ctx.beginPath();
  ctx.rect(0, 0, map.width, map.height);
  ctx.fill();
  for (const region of map.terrainRegions) {
    ctx.fillStyle = terrainColor(region.terrain);
    traceShape(ctx, region);
    ctx.fill();
  }

  ctx.lineWidth = px;
  for (const obstacle of map.obstacles) {
    ctx.fillStyle = obstacle.destructible ? DESTRUCTIBLE_COLOR : OBSTACLE_COLOR;
    ctx.strokeStyle = BOUNDARY_COLOR;
    traceShape(ctx, obstacle);
    ctx.fill();
    ctx.stroke();
  }

  if (options.spawnZones !== false) {
    map.spawnZones.forEach((zone, i) => {
      drawSpawnZone(ctx, zone, entryColor(i), px);
    });
  }

  ctx.strokeStyle = BOUNDARY_COLOR;
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.rect(0, 0, map.width, map.height);
  ctx.stroke();
  ctx.restore();
}

function drawSpawnZone(ctx: Context, zone: Shape & { readonly heading: number }, color: string, px: number): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * px;
  traceShape(ctx, zone);
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.stroke();
  ctx.setLineDash([]);

  // The arrow runs through the zone's centre along its Heading.
  const b = shapeBounds(zone);
  const half = Math.min(b.maxX - b.minX, b.maxY - b.minY) * 0.3;
  const head = half * 0.5;
  ctx.save();
  transform(ctx, poseMatrix({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, heading: zone.heading }));
  ctx.beginPath();
  ctx.moveTo(0, half);
  ctx.lineTo(0, -half);
  ctx.moveTo(-head, -half + head);
  ctx.lineTo(0, -half);
  ctx.lineTo(head, -half + head);
  ctx.stroke();
  ctx.restore();
}

/**
 * Ray tracing against the world, shared by weapon fire and sensors.
 *
 * Rays stop at the first Bot, wreck, Obstacle or Map boundary they meet.
 * Destructible Obstacles destroyed this Tick still count until they are
 * removed at its end.
 */

import type { Collider } from "./events.js";
import { rayEntry, rayExit, type Point, type WorldShape } from "./geometry.js";
import { botShape, type World } from "./world.js";

export interface RayHit {
  readonly distance: number;
  /** Null when the ray reached its full length. */
  readonly target: Collider | null;
  readonly shape: WorldShape | null;
}

/**
 * The first thing a ray from `from` in the unit direction `dir` meets within
 * `length`, ignoring the Bot `ignore` and its wreck. Ties go to Bots in id
 * order, then Obstacles in Map order, then the boundary, which counts only
 * when `boundary` is true.
 */
export function castRay(world: World, from: Point, dir: Point, length: number, ignore: number, boundary: boolean): RayHit {
  let best: RayHit = { distance: length, target: null, shape: null };
  const consider = (shape: WorldShape, target: Collider) => {
    const t = rayEntry(from, dir, best.distance, shape);
    if (t !== null && (best.target === null || t < best.distance)) best = { distance: t, target, shape };
  };
  for (const b of world.bots) {
    if (b.id === ignore) continue;
    consider(botShape(b), { kind: b.status === "disabled" ? "wreck" : "bot", id: b.id });
  }
  for (const o of world.obstacles) consider(o.shape, { kind: "obstacle", id: o.obstacle.id });
  if (boundary) {
    const exit = rayExit(from, dir, { minX: 0, minY: 0, maxX: world.map.width, maxY: world.map.height });
    if (exit < best.distance || (exit === best.distance && best.target === null)) {
      best = { distance: exit, target: { kind: "boundary" }, shape: null };
    }
  }
  return best;
}

export function along(from: Point, dir: Point, distance: number): Point {
  return { x: from.x + dir.x * distance, y: from.y + dir.y * distance };
}

/**
 * Whether the straight line from `from` to `to`, both ends included, is clear
 * of every Obstacle and wreck. Live Bots do not block line of sight.
 */
export function lineOfSight(world: World, from: Point, to: Point): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const dir = length === 0 ? { x: 0, y: -1 } : { x: dx / length, y: dy / length };
  for (const o of world.obstacles) if (rayEntry(from, dir, length, o.shape) !== null) return false;
  for (const b of world.bots) {
    if (b.status === "disabled" && rayEntry(from, dir, length, botShape(b)) !== null) return false;
  }
  return true;
}

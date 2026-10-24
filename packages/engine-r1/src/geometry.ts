/**
 * Planar geometry for the r1 simulation.
 *
 * This is engine-r1's own copy rather than ruleset-data's validation helpers,
 * so that later changes to Map validation can never change how a frozen
 * Ruleset plays. Only basic arithmetic, Math.sqrt and the pinned trigonometry
 * are used, so results are bit-identical everywhere (ADR-0005).
 *
 * Shapes are closed: a point on a boundary is inside, and shapes that merely
 * touch overlap. World coordinates are Map coordinates (meters, y down).
 */

import { atan2Deg, cosDeg, normalizeAbsAngle, normalizeAngle, sinDeg } from "./math.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A shape in world coordinates. */
export type WorldShape =
  | { readonly shape: "circle"; readonly x: number; readonly y: number; readonly radius: number }
  | { readonly shape: "polygon"; readonly points: readonly Point[] };

/** A shape in the Bot frame: x right, y down, Heading pointing up (-y). */
export type LocalShape =
  | { readonly shape: "circle"; readonly radius: number }
  | { readonly shape: "polygon"; readonly points: readonly Point[] };

/** The unit vector of an absolute Heading (0 is up the Map, clockwise). */
export function headingVector(heading: number): Point {
  return { x: sinDeg(heading), y: -cosDeg(heading) };
}

/** The absolute bearing from one point to another, in [0, 360); 0 when they coincide. */
export function absBearing(from: Point, to: Point): number {
  return normalizeAbsAngle(atan2Deg(to.x - from.x, from.y - to.y));
}

/**
 * Whether an absolute bearing lies within an arc `arcWidth` degrees wide,
 * centred on `direction` relative to `heading`, ends included. An arc of 360
 * covers every bearing.
 */
export function inArc(heading: number, direction: number, arcWidth: number, bearing: number): boolean {
  const offset = normalizeAngle(normalizeAngle(bearing - heading) - direction);
  return Math.abs(offset) <= arcWidth / 2;
}

/** Places a Bot-frame shape at a world position and absolute Heading. */
export function placeShape(local: LocalShape, x: number, y: number, heading: number): WorldShape {
  if (local.shape === "circle") return { shape: "circle", x, y, radius: local.radius };
  const s = sinDeg(heading);
  const c = cosDeg(heading);
  return {
    shape: "polygon",
    points: local.points.map((p) => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c })),
  };
}

/** The distance from the Bot's centre to the farthest point of its shape. */
export function shapeReach(local: LocalShape): number {
  if (local.shape === "circle") return local.radius;
  let max = 0;
  for (const p of local.points) max = Math.max(max, Math.sqrt(p.x * p.x + p.y * p.y));
  return max;
}

function at(points: readonly Point[], i: number): Point {
  const p = points[i % points.length];
  if (p === undefined) throw new RangeError("empty polygon");
  return p;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function withinBox(p: Point, q: Point, r: Point): boolean {
  return (
    q.x >= Math.min(p.x, r.x) &&
    q.x <= Math.max(p.x, r.x) &&
    q.y >= Math.min(p.y, r.y) &&
    q.y <= Math.max(p.y, r.y)
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && withinBox(c, a, d)) ||
    (d2 === 0 && withinBox(c, b, d)) ||
    (d3 === 0 && withinBox(a, c, b)) ||
    (d4 === 0 && withinBox(a, d, b))
  );
}

/** Whether p is inside the polygon or on its boundary. */
export function pointInPolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i);
    const b = at(points, i + 1);
    if (cross(a, b, p) === 0 && withinBox(a, p, b)) return true;
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

/** Whether p is inside the shape or on its boundary. */
export function pointInShape(p: Point, s: WorldShape): boolean {
  if (s.shape === "polygon") return pointInPolygon(p, s.points);
  const dx = p.x - s.x;
  const dy = p.y - s.y;
  return dx * dx + dy * dy <= s.radius * s.radius;
}

function closestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function distanceSq(p: Point, q: Point): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return dx * dx + dy * dy;
}

/**
 * The point on the shape's boundary nearest to p. Ties go to the earliest
 * polygon edge; for a circle centred on p, the point straight up.
 */
export function closestBoundaryPoint(p: Point, s: WorldShape): Point {
  if (s.shape === "circle") {
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d === 0) return { x: s.x, y: s.y - s.radius };
    return { x: s.x + (dx / d) * s.radius, y: s.y + (dy / d) * s.radius };
  }
  let best = closestOnSegment(p, at(s.points, 0), at(s.points, 1));
  let bestD = distanceSq(p, best);
  for (let i = 1; i < s.points.length; i++) {
    const q = closestOnSegment(p, at(s.points, i), at(s.points, i + 1));
    const d = distanceSq(p, q);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

function circlePolygonOverlap(c: { x: number; y: number; radius: number }, points: readonly Point[]): boolean {
  if (pointInPolygon(c, points)) return true;
  const r2 = c.radius * c.radius;
  for (let i = 0; i < points.length; i++) {
    if (distanceSq(c, closestOnSegment(c, at(points, i), at(points, i + 1))) <= r2) return true;
  }
  return false;
}

/** Whether two closed shapes share any point. */
export function shapesOverlap(s: WorldShape, t: WorldShape): boolean {
  if (s.shape === "circle") {
    if (t.shape === "polygon") return circlePolygonOverlap(s, t.points);
    const r = s.radius + t.radius;
    return distanceSq(s, t) <= r * r;
  }
  if (t.shape === "circle") return circlePolygonOverlap(t, s.points);
  const p = s.points;
  const q = t.points;
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (segmentsIntersect(at(p, i), at(p, i + 1), at(q, j), at(q, j + 1))) return true;
    }
  }
  return pointInPolygon(at(p, 0), q) || pointInPolygon(at(q, 0), p);
}

/** Twice the signed area; positive when the points run clockwise in Map coordinates (y down). */
function polygonArea2(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i);
    const b = at(points, i + 1);
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

function unit(dx: number, dy: number): Point {
  const d = Math.sqrt(dx * dx + dy * dy);
  return d === 0 ? { x: 0, y: -1 } : { x: dx / d, y: dy / d };
}

/** The contact of a circle with a polygon, the normal pointing from the circle. */
function circlePolygonContact(
  circle: { readonly x: number; readonly y: number; readonly radius: number },
  polygon: WorldShape,
): Contact {
  const q = closestBoundaryPoint(circle, polygon);
  const normal = unit(q.x - circle.x, q.y - circle.y);
  const p = { x: circle.x + normal.x * circle.radius, y: circle.y + normal.y * circle.radius };
  return { point: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, normal };
}

/** Where two nearby, separate shapes meet, and the unit direction from the first towards the second. */
export interface Contact {
  readonly point: Point;
  readonly normal: Point;
}

/**
 * The contact between two shapes that are close but do not overlap: the
 * midpoint of their nearest points, and a normal pointing from s towards t.
 * The normal is taken from a circle's centre or a polygon edge's outward
 * direction, never from the tiny gap between the nearest points, so it stays
 * accurate however close the shapes are. Between two polygons, ties go to s's
 * vertices first, then t's, each in order.
 */
export function contact(s: WorldShape, t: WorldShape): Contact {
  if (s.shape === "circle") {
    if (t.shape === "polygon") return circlePolygonContact(s, t);
    const normal = unit(t.x - s.x, t.y - s.y);
    const mid = (s.radius + Math.sqrt(distanceSq(s, t)) - t.radius) / 2;
    return { point: { x: s.x + normal.x * mid, y: s.y + normal.y * mid }, normal };
  }
  if (t.shape === "circle") {
    const c = circlePolygonContact(t, s);
    return { point: c.point, normal: { x: -c.normal.x, y: -c.normal.y } };
  }

  let best: Contact | undefined;
  let bestD = Infinity;
  const search = (vertices: readonly Point[], edges: readonly Point[], towardsT: number) => {
    const clockwise = polygonArea2(edges) > 0;
    for (const v of vertices) {
      for (let i = 0; i < edges.length; i++) {
        const a = at(edges, i);
        const b = at(edges, i + 1);
        const q = closestOnSegment(v, a, b);
        const d = distanceSq(v, q);
        if (d >= bestD) continue;
        bestD = d;
        // The edge's outward normal, from the polygon's winding.
        const out = clockwise ? unit(b.y - a.y, a.x - b.x) : unit(a.y - b.y, b.x - a.x);
        best = {
          point: { x: (v.x + q.x) / 2, y: (v.y + q.y) / 2 },
          normal: { x: out.x * towardsT, y: out.y * towardsT },
        };
      }
    }
  };
  search(s.points, t.points, -1); // t's edge faces s
  search(t.points, s.points, 1); // s's edge faces t
  if (best === undefined) throw new RangeError("empty polygon");
  return best;
}

/**
 * How far along the ray from `from` in the unit direction `dir` it first
 * meets the closed shape: 0 if `from` is inside it, or null if it does not
 * within `maxDistance`.
 */
export function rayEntry(from: Point, dir: Point, maxDistance: number, s: WorldShape): number | null {
  if (pointInShape(from, s)) return 0;
  if (s.shape === "circle") {
    const fx = from.x - s.x;
    const fy = from.y - s.y;
    const b = fx * dir.x + fy * dir.y;
    const disc = b * b - (fx * fx + fy * fy - s.radius * s.radius);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t >= 0 && t <= maxDistance ? t : null;
  }
  let best: number | null = null;
  for (let i = 0; i < s.points.length; i++) {
    const p = at(s.points, i);
    const q = at(s.points, i + 1);
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const wx = p.x - from.x;
    const wy = p.y - from.y;
    const denom = dir.x * ey - dir.y * ex;
    let t: number;
    if (denom === 0) {
      if (wx * dir.y - wy * dir.x !== 0) continue; // parallel, not on the ray's line
      // Along the ray's line: it meets the edge at its nearer end ahead.
      const tp = wx * dir.x + wy * dir.y;
      const tq = (q.x - from.x) * dir.x + (q.y - from.y) * dir.y;
      if (tp < 0 && tq < 0) continue;
      t = tp < 0 || tq < 0 ? 0 : Math.min(tp, tq);
    } else {
      t = (wx * ey - wy * ex) / denom;
      const u = (wx * dir.y - wy * dir.x) / denom;
      if (t < 0 || u < 0 || u > 1) continue;
    }
    if (t <= maxDistance && (best === null || t < best)) best = t;
  }
  return best;
}

/** How far the ray from `from`, inside the box, travels in the unit direction `dir` before leaving it. */
export function rayExit(from: Point, dir: Point, b: Bounds): number {
  const tx = dir.x > 0 ? (b.maxX - from.x) / dir.x : dir.x < 0 ? (b.minX - from.x) / dir.x : Infinity;
  const ty = dir.y > 0 ? (b.maxY - from.y) / dir.y : dir.y < 0 ? (b.minY - from.y) / dir.y : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function shapeBounds(s: WorldShape): Bounds {
  if (s.shape === "circle") {
    return { minX: s.x - s.radius, minY: s.y - s.radius, maxX: s.x + s.radius, maxY: s.y + s.radius };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of s.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Whether two bounding boxes share any point; a cheap pre-check for shapesOverlap. */
export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

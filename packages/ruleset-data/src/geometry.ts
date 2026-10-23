/**
 * Planar geometry predicates for validating Map shapes.
 *
 * All shapes are closed: a point on a boundary is inside, and shapes that
 * merely touch count as overlapping. Only basic arithmetic is used, so
 * results are exact for integer coordinates and deterministic everywhere.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Polygon {
  readonly shape: "polygon";
  readonly points: readonly Point[];
}

export interface Circle {
  readonly shape: "circle";
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export type Shape = Polygon | Circle;

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function at(points: readonly Point[], i: number): Point {
  const p = points[i % points.length];
  if (p === undefined) throw new RangeError("empty polygon");
  return p;
}

/** Twice the signed area; positive when the points run clockwise in Map coordinates (y down). */
export function polygonArea2(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i);
    const b = at(points, i + 1);
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

// q is known to be collinear with p and r; is it within their bounding box?
function withinBox(p: Point, q: Point, r: Point): boolean {
  return (
    q.x >= Math.min(p.x, r.x) &&
    q.x <= Math.max(p.x, r.x) &&
    q.y >= Math.min(p.y, r.y) &&
    q.y <= Math.max(p.y, r.y)
  );
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  return cross(a, b, p) === 0 && withinBox(a, p, b);
}

/** Whether closed segments ab and cd share any point. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
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

/**
 * Whether the polygon's edges meet only at shared vertices of neighbouring
 * edges. Assumes at least three points and no repeated consecutive points.
 */
export function isSimplePolygon(points: readonly Point[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = at(points, i);
    const b = at(points, i + 1);
    const c = at(points, i + 2);
    // Neighbouring edges that fold back over each other.
    if (cross(a, b, c) === 0 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) {
      return false;
    }
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the closing edge
      if (segmentsIntersect(a, b, at(points, j), at(points, j + 1))) return false;
    }
  }
  return true;
}

/** Whether p is inside the polygon or on its boundary. */
export function pointInPolygon(p: Point, points: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = at(points, i);
    const b = at(points, i + 1);
    if (onSegment(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

function segmentDistanceSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = a.x + t * dx - p.x;
  const ey = a.y + t * dy - p.y;
  return ex * ex + ey * ey;
}

function circlePolygonOverlap(c: Circle, poly: Polygon): boolean {
  if (pointInPolygon(c, poly.points)) return true;
  const r2 = c.radius * c.radius;
  for (let i = 0; i < poly.points.length; i++) {
    if (segmentDistanceSq(c, at(poly.points, i), at(poly.points, i + 1)) <= r2) return true;
  }
  return false;
}

/** Whether two closed shapes share any point. */
export function shapesOverlap(s: Shape, t: Shape): boolean {
  if (s.shape === "circle") {
    if (t.shape === "polygon") return circlePolygonOverlap(s, t);
    const dx = s.x - t.x;
    const dy = s.y - t.y;
    const r = s.radius + t.radius;
    return dx * dx + dy * dy <= r * r;
  }
  if (t.shape === "circle") return circlePolygonOverlap(t, s);
  const p = s.points;
  const q = t.points;
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (segmentsIntersect(at(p, i), at(p, i + 1), at(q, j), at(q, j + 1))) return true;
    }
  }
  return pointInPolygon(at(p, 0), q) || pointInPolygon(at(q, 0), p);
}

/** Whether the shape lies entirely within the rectangle [0, width] x [0, height]. */
export function shapeWithinBounds(s: Shape, width: number, height: number): boolean {
  if (s.shape === "circle") {
    return s.x - s.radius >= 0 && s.y - s.radius >= 0 && s.x + s.radius <= width && s.y + s.radius <= height;
  }
  return s.points.every((p) => p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height);
}

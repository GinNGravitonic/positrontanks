/**
 * Geometry for drawing in Map meters (frontend spec section 7). Maps and Bots
 * share one convention: x to the right, y down, and bearings in degrees with
 * 0 up (-y) and positive clockwise. A Bot's frame has its Heading up, and a
 * Slot's frame (a Slot's position and direction in the Bot frame) has the
 * Slot direction up, so one rotation serves Map, Bot and Slot alike.
 *
 * A View is what a canvas shows: the Map point at its centre and its scale in
 * CSS pixels per meter. Transforms are affine matrices in the argument order
 * of CanvasRenderingContext2D.transform.
 */

import type { ChassisShape, Point, Shape } from "@positrontanks/ruleset-data";

/** A position and a facing: a Bot on the Map, or a Slot on its Chassis. */
export interface Pose {
  readonly x: number;
  readonly y: number;
  /** Degrees, 0 up, positive clockwise. */
  readonly heading: number;
}

/** The affine transform (a c e / b d f / 0 0 1), as `[a, b, c, d, e, f]`. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` after `n`: the transform that applies `n` first, then `m`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

export function apply(m: Matrix, p: Point): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function translation(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

export function scaling(s: number): Matrix {
  return [s, 0, 0, s, 0, 0];
}

/** A clockwise turn by `degrees` (with y down, as on a canvas). */
export function rotation(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

/** From the frame of something at `pose` (its facing up) into the frame `pose` is given in. */
export function poseMatrix(pose: Pose): Matrix {
  return multiply(translation(pose.x, pose.y), rotation(pose.heading));
}

/** What a canvas shows: the Map point at its centre, its scale, and its size in CSS pixels. */
export interface View {
  readonly centerX: number;
  readonly centerY: number;
  /** CSS pixels per meter. */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
}

/** From Map meters to the canvas's CSS pixels. */
export function viewMatrix(view: View): Matrix {
  return multiply(
    translation(view.width / 2, view.height / 2),
    multiply(scaling(view.scale), translation(-view.centerX, -view.centerY)),
  );
}

export function mapToScreen(view: View, p: Point): Point {
  return apply(viewMatrix(view), p);
}

export function screenToMap(view: View, p: Point): Point {
  return apply(invert(viewMatrix(view)), p);
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function boundsOf(points: readonly Point[]): Bounds {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

export function unionBounds(bounds: readonly Bounds[]): Bounds {
  return {
    minX: Math.min(...bounds.map((b) => b.minX)),
    minY: Math.min(...bounds.map((b) => b.minY)),
    maxX: Math.max(...bounds.map((b) => b.maxX)),
    maxY: Math.max(...bounds.map((b) => b.maxY)),
  };
}

/** The corners of `bounds`, clockwise from top-left. */
export function corners(bounds: Bounds): Point[] {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}

/** A Map feature's shape, or a Chassis outline (whose circle is centred on the Bot). */
export type AnyShape = Shape | ChassisShape;

export function shapeBounds(shape: AnyShape): Bounds {
  if (shape.shape === "polygon") return boundsOf(shape.points);
  const x = "x" in shape ? shape.x : 0;
  const y = "y" in shape ? shape.y : 0;
  return { minX: x - shape.radius, minY: y - shape.radius, maxX: x + shape.radius, maxY: y + shape.radius };
}

/** The View showing all of `bounds` plus `margin` meters around it, as large as fits, centred. */
export function fitView(bounds: Bounds, width: number, height: number, margin = 0): View {
  const w = bounds.maxX - bounds.minX + 2 * margin;
  const h = bounds.maxY - bounds.minY + 2 * margin;
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scale: Math.min(width / w, height / h),
    width,
    height,
  };
}

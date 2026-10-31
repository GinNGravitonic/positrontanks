/**
 * The part of CanvasRenderingContext2D the drawing uses, so tests can record
 * what is drawn without a canvas, and the path helper shared by Maps and Bots.
 */

import type { AnyShape, Matrix } from "./geometry.js";

export type Context = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "transform"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "arc"
  | "rect"
  | "fill"
  | "stroke"
  | "setLineDash"
  | "fillText"
  | "strokeText"
  | "drawImage"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineJoin"
  | "globalAlpha"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

/** Resolves an artwork reference to an image ready to draw, or `undefined` to draw the placeholder. */
export type Artwork = (ref: string) => CanvasImageSource | undefined;

export function transform(ctx: Context, m: Matrix): void {
  ctx.transform(...m);
}

/** Starts a new path tracing `shape`. */
export function traceShape(ctx: Context, shape: AnyShape): void {
  ctx.beginPath();
  if (shape.shape === "circle") {
    const x = "x" in shape ? shape.x : 0;
    const y = "y" in shape ? shape.y : 0;
    ctx.arc(x, y, shape.radius, 0, 2 * Math.PI);
    return;
  }
  shape.points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

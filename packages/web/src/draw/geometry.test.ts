import { describe, expect, it } from "vitest";
import {
  apply,
  fitView,
  invert,
  mapToScreen,
  multiply,
  poseMatrix,
  rotation,
  screenToMap,
  shapeBounds,
  translation,
  unionBounds,
  viewMatrix,
  type Matrix,
  type View,
} from "./geometry.js";

const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

describe("rotation", () => {
  it("turns up (-y) clockwise, with y down", () => {
    const ahead = { x: 0, y: -1 };
    close(apply(rotation(0), ahead), 0, -1);
    close(apply(rotation(90), ahead), 1, 0);
    close(apply(rotation(180), ahead), 0, 1);
    close(apply(rotation(-90), ahead), -1, 0);
    close(apply(rotation(45), ahead), Math.SQRT1_2, -Math.SQRT1_2);
  });
});

describe("matrices", () => {
  it("multiply applies the right-hand transform first", () => {
    const m = multiply(translation(10, 0), rotation(90));
    close(apply(m, { x: 0, y: -1 }), 11, 0);
    const n = multiply(rotation(90), translation(10, 0));
    close(apply(n, { x: 0, y: -1 }), 1, 10);
  });

  it("invert undoes a transform", () => {
    const m: Matrix = multiply(translation(3, -7), multiply(rotation(33), [2, 0, 0, 2, 0, 0]));
    close(apply(invert(m), apply(m, { x: 1.5, y: -4 })), 1.5, -4);
  });
});

describe("poseMatrix", () => {
  it("takes a point in a Bot's frame onto the Map", () => {
    const bot = poseMatrix({ x: 10, y: 20, heading: 90 });
    close(apply(bot, { x: 0, y: 0 }), 10, 20);
    // A Slot 0.3 m ahead of the centre points east when the Bot faces east.
    close(apply(bot, { x: 0, y: -0.3 }), 10.3, 20);
    // Its right side faces south.
    close(apply(bot, { x: 0.5, y: 0 }), 10, 20.5);
  });

  it("composes a Slot's frame inside the Bot's", () => {
    // A gun on the right side (x 0.7), facing right (90), on a Bot facing south (180): it points west.
    const gun = multiply(poseMatrix({ x: 10, y: 20, heading: 180 }), poseMatrix({ x: 0.7, y: 0, heading: 90 }));
    close(apply(gun, { x: 0, y: 0 }), 9.3, 20);
    close(apply(gun, { x: 0, y: -1 }), 8.3, 20);
  });
});

describe("View", () => {
  const view: View = { centerX: 40, centerY: 30, scale: 5, width: 400, height: 300 };

  it("puts its centre in the middle of the canvas, at its scale", () => {
    close(mapToScreen(view, { x: 40, y: 30 }), 200, 150);
    close(mapToScreen(view, { x: 41, y: 32 }), 205, 160);
    expect(viewMatrix(view)).toEqual([5, 0, 0, 5, 0, 0]);
  });

  it("screenToMap inverts mapToScreen", () => {
    close(screenToMap(view, mapToScreen(view, { x: 12.25, y: 7.5 })), 12.25, 7.5);
    close(screenToMap(view, { x: 0, y: 0 }), 0, 0);
  });

  it("fitView fits the bounds' longer side, centred", () => {
    const fitted = fitView({ minX: 0, minY: 0, maxX: 80, maxY: 40 }, 400, 400);
    expect(fitted).toEqual({ centerX: 40, centerY: 20, scale: 5, width: 400, height: 400 });
    close(mapToScreen(fitted, { x: 0, y: 0 }), 0, 100);
    close(mapToScreen(fitted, { x: 80, y: 40 }), 400, 300);
  });

  it("fitView leaves the margin, in meters, around the bounds", () => {
    const fitted = fitView({ minX: 0, minY: 0, maxX: 80, maxY: 80 }, 410, 410, 1);
    expect(fitted.scale).toBe(5);
    close(mapToScreen(fitted, { x: 0, y: 0 }), 5, 5);
  });
});

describe("bounds", () => {
  it("of a Chassis circle is centred on the Bot, of a Map circle on its centre", () => {
    expect(shapeBounds({ shape: "circle", radius: 0.5 })).toEqual({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 });
    expect(shapeBounds({ shape: "circle", x: 10, y: 70, radius: 5 })).toEqual({ minX: 5, minY: 65, maxX: 15, maxY: 75 });
  });

  it("of a polygon spans its points, and unions span every part", () => {
    const wedge = shapeBounds({ shape: "polygon", points: [{ x: 0, y: -1 }, { x: 0.8, y: 0.6 }, { x: -0.8, y: 0.6 }] });
    expect(wedge).toEqual({ minX: -0.8, minY: -1, maxX: 0.8, maxY: 0.6 });
    expect(unionBounds([wedge, { minX: 0, minY: 0, maxX: 2, maxY: 0.1 }])).toEqual({ minX: -0.8, minY: -1, maxX: 2, maxY: 0.6 });
  });
});

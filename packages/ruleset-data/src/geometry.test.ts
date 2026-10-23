import { describe, expect, it } from "vitest";
import {
  isSimplePolygon,
  pointInPolygon,
  segmentsIntersect,
  shapesOverlap,
  shapeWithinBounds,
  type Shape,
} from "./geometry.js";

const p = (x: number, y: number) => ({ x, y });
const square = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)];
const poly = (points: { x: number; y: number }[]): Shape => ({ shape: "polygon", points });
const circle = (x: number, y: number, radius: number): Shape => ({ shape: "circle", x, y, radius });

describe("segmentsIntersect", () => {
  it.each([
    ["crossing", p(0, 0), p(10, 10), p(0, 10), p(10, 0), true],
    ["parallel", p(0, 0), p(10, 0), p(0, 1), p(10, 1), false],
    ["touching at an end", p(0, 0), p(10, 0), p(10, 0), p(10, 5), true],
    ["T-junction", p(0, 0), p(10, 0), p(5, 0), p(5, 5), true],
    ["collinear overlapping", p(0, 0), p(10, 0), p(5, 0), p(15, 0), true],
    ["collinear apart", p(0, 0), p(4, 0), p(5, 0), p(10, 0), false],
  ])("%s", (_, a, b, c, d, expected) => {
    expect(segmentsIntersect(a, b, c, d)).toBe(expected);
  });
});

describe("isSimplePolygon", () => {
  it("accepts convex and concave polygons", () => {
    expect(isSimplePolygon(square)).toBe(true);
    expect(isSimplePolygon([p(0, 0), p(10, 0), p(10, 10), p(5, 3), p(0, 10)])).toBe(true);
  });

  it("rejects a bow tie and a polygon touching itself", () => {
    expect(isSimplePolygon([p(0, 0), p(10, 10), p(10, 0), p(0, 10)])).toBe(false);
    expect(isSimplePolygon([p(0, 0), p(10, 0), p(5, 5), p(10, 10), p(0, 10), p(5, 5)])).toBe(false);
  });
});

describe("pointInPolygon", () => {
  it.each([
    [p(5, 5), true],
    [p(0, 5), true],
    [p(10, 10), true],
    [p(11, 5), false],
    [p(-1, 0), false],
  ])("%o", (point, expected) => {
    expect(pointInPolygon(point, square)).toBe(expected);
  });
});

describe("shapesOverlap", () => {
  it.each([
    ["circles apart", circle(0, 0, 1), circle(3, 0, 1), false],
    ["circles touching", circle(0, 0, 1), circle(2, 0, 1), true],
    ["circle inside polygon", circle(5, 5, 1), poly(square), true],
    ["circle near a corner", circle(11, 11, 1), poly(square), false],
    ["circle touching an edge", circle(11, 5, 1), poly(square), true],
    ["polygon containing polygon", poly(square), poly([p(4, 4), p(6, 4), p(6, 6)]), true],
    ["polygons sharing an edge", poly(square), poly([p(10, 0), p(20, 0), p(20, 10), p(10, 10)]), true],
    ["polygons apart", poly(square), poly([p(11, 0), p(20, 0), p(20, 10)]), false],
  ])("%s", (_, a, b, expected) => {
    expect(shapesOverlap(a, b)).toBe(expected);
    expect(shapesOverlap(b, a)).toBe(expected);
  });
});

describe("shapeWithinBounds", () => {
  it("includes the boundary itself", () => {
    expect(shapeWithinBounds(poly(square), 10, 10)).toBe(true);
    expect(shapeWithinBounds(circle(5, 5, 5), 10, 10)).toBe(true);
    expect(shapeWithinBounds(circle(5, 5, 5.5), 10, 10)).toBe(false);
    expect(shapeWithinBounds(poly(square), 10, 9)).toBe(false);
  });
});

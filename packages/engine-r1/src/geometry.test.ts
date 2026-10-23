import { describe, expect, it } from "vitest";
import { contact, headingVector, placeShape, rayEntry, rayExit, shapesOverlap, type WorldShape } from "./geometry.js";

const square = (x: number, y: number, half: number): WorldShape => ({
  shape: "polygon",
  points: [
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x + half, y: y + half },
    { x: x - half, y: y + half },
  ],
});

describe("placeShape", () => {
  it("rotates the Bot frame clockwise with the Heading", () => {
    const nose = { shape: "polygon" as const, points: [{ x: 0, y: -1 }, { x: 0.5, y: 0 }, { x: -0.5, y: 0 }] };
    const placed = placeShape(nose, 10, 20, 90);
    if (placed.shape !== "polygon") throw new Error("expected a polygon");
    expect(placed.points[0]?.x).toBeCloseTo(11, 12);
    expect(placed.points[0]?.y).toBeCloseTo(20, 12);
    expect(headingVector(90).x).toBe(1);
    expect(headingVector(180).y).toBe(1);
  });
});

describe("contact", () => {
  it("meets two circles midway along the line of centres", () => {
    const k = contact({ shape: "circle", x: 0, y: 0, radius: 1 }, { shape: "circle", x: 3, y: 0, radius: 1 });
    expect(k).toEqual({ point: { x: 1.5, y: 0 }, normal: { x: 1, y: 0 } });
  });

  it("uses the polygon edge's outward normal whichever way the polygon winds", () => {
    const cw = square(0, 0, 1);
    const ccw: WorldShape = { shape: "polygon", points: [...(cw.shape === "polygon" ? cw.points : [])].reverse() };
    for (const s of [cw, ccw]) {
      const k = contact(s, square(2.1, 0.5, 1));
      expect(k.normal.x).toBe(1);
      expect(k.normal.y).toBeCloseTo(0, 12);
      expect(k.point.x).toBeCloseTo(1.05, 12);
    }
  });

  it("gives opposite normals and the same point when the shapes swap", () => {
    const shapes: WorldShape[] = [
      { shape: "circle", x: 0, y: 0, radius: 1 },
      square(0.3, 2.2, 1),
      { shape: "circle", x: -2.5, y: 0.4, radius: 1.2 },
    ];
    for (const s of shapes) {
      for (const t of shapes) {
        if (s === t || shapesOverlap(s, t)) continue;
        const a = contact(s, t);
        const b = contact(t, s);
        expect(b.normal.x).toBeCloseTo(-a.normal.x, 12);
        expect(b.normal.y).toBeCloseTo(-a.normal.y, 12);
        expect(b.point.x).toBeCloseTo(a.point.x, 12);
        expect(b.point.y).toBeCloseTo(a.point.y, 12);
      }
    }
  });
});

describe("rayEntry", () => {
  const right = { x: 1, y: 0 };

  it("finds where a ray first meets a circle or polygon, within its length", () => {
    const circle: WorldShape = { shape: "circle", x: 10, y: 0, radius: 2 };
    expect(rayEntry({ x: 0, y: 0 }, right, 20, circle)).toBe(8);
    expect(rayEntry({ x: 0, y: 0 }, right, 7, circle)).toBeNull();
    expect(rayEntry({ x: 0, y: 3 }, right, 20, circle)).toBeNull();
    expect(rayEntry({ x: 20, y: 0 }, right, 20, circle)).toBeNull(); // behind
    expect(rayEntry({ x: 0, y: 0 }, right, 20, square(10, 0, 2))).toBe(8);
    expect(rayEntry({ x: 0, y: 2 }, right, 20, square(10, 0, 2))).toBe(8); // grazing an edge
    expect(rayEntry({ x: 0, y: 2.1 }, right, 20, square(10, 0, 2))).toBeNull();
  });

  it("is 0 from inside the shape", () => {
    expect(rayEntry({ x: 10, y: 0 }, right, 5, square(10, 0, 2))).toBe(0);
    expect(rayEntry({ x: 10, y: 0 }, right, 5, { shape: "circle", x: 10, y: 0, radius: 2 })).toBe(0);
  });
});

describe("rayExit", () => {
  it("finds where a ray leaves a box", () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    expect(rayExit({ x: 10, y: 10 }, { x: 1, y: 0 }, box)).toBe(90);
    expect(rayExit({ x: 10, y: 10 }, { x: 0, y: -1 }, box)).toBe(10);
    expect(rayExit({ x: 10, y: 10 }, { x: -0.6, y: 0.8 }, box)).toBeCloseTo(10 / 0.6, 12);
  });
});

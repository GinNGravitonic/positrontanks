import { describe, expect, it } from "vitest";
import type { Bounds, View } from "../draw/geometry.js";
import { mapToScreen } from "../draw/geometry.js";
import { centerOn, defaultView, panBy, resizeView, viewBounds, zoomAt, zoomLimits } from "./camera.js";

const map: Bounds = { minX: 0, minY: 0, maxX: 80, maxY: 60 };

describe("zoomLimits", () => {
  it("measures maximum and default zoom across the view's shorter side", () => {
    const limits = zoomLimits(map, 800, 600);
    expect(600 / limits.max).toBeCloseTo(4, 9);
    expect(600 / limits.default).toBeCloseTo(15, 9);
  });

  it("zooms out no further than the whole Map plus a margin", () => {
    const limits = zoomLimits(map, 800, 600);
    // 84 x 64 m into 800 x 600 px: the height decides.
    expect(limits.min).toBeCloseTo(600 / 64, 9);
  });

  it("puts the default at minimum zoom on a Map smaller than 15 m", () => {
    const limits = zoomLimits({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 400, 400);
    expect(limits.default).toBe(limits.min);
    expect(limits.min).toBeCloseTo(400 / 14, 9);
  });
});

describe("the main view's camera", () => {
  const view = defaultView(map, 800, 600, { x: 20, y: 30 });

  it("starts at the default zoom on the given point", () => {
    expect(view).toEqual({ centerX: 20, centerY: 30, scale: 40, width: 800, height: 600 });
  });

  it("zooms within the limits", () => {
    const limits = zoomLimits(map, 800, 600);
    expect(zoomAt(view, map, { x: 400, y: 300 }, 1000).scale).toBe(limits.max);
    expect(zoomAt(view, map, { x: 400, y: 300 }, 0.001).scale).toBe(limits.min);
  });

  it("keeps the point under the pointer where it is when zooming", () => {
    const at = { x: 650, y: 120 };
    const before = { x: 20 + (650 - 400) / 40, y: 30 + (120 - 300) / 40 };
    const zoomed = zoomAt(view, map, at, 1.5);
    const after = mapToScreen(zoomed, before);
    expect(after.x).toBeCloseTo(at.x, 9);
    expect(after.y).toBeCloseTo(at.y, 9);
  });

  it("pans with the drag, the Map following the pointer, and keeps its centre on the Map", () => {
    expect(panBy(view, map, 40, -80)).toMatchObject({ centerX: 19, centerY: 32 });
    expect(panBy(view, map, 100000, 0).centerX).toBe(0);
    expect(centerOn(view, map, { x: 90, y: -5 })).toMatchObject({ centerX: 80, centerY: 0 });
  });

  it("keeps its centre and scale when resized, within the new limits", () => {
    const resized = resizeView(view, map, 400, 300);
    expect(resized).toEqual({ ...view, width: 400, height: 300 });
    const huge: View = { ...view, scale: 1000 };
    expect(resizeView(huge, map, 400, 300).scale).toBe(300 / 4);
  });

  it("knows the part of the Map it shows", () => {
    expect(viewBounds(view)).toEqual({ minX: 10, minY: 22.5, maxX: 30, maxY: 37.5 });
  });
});

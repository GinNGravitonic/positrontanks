import { describe, expect, it } from "vitest";
import type { Bounds, View } from "../draw/geometry.js";
import { viewBounds, zoomLimits } from "./camera.js";
import { botAt, ease, engagedBots, follow, followStep, targetFraming, zoomFollowing, type Camera } from "./follow.js";
import type { Hit, Scene, SceneBot } from "./scene.js";

const map: Bounds = { minX: 0, minY: 0, maxX: 80, maxY: 60 };
const tickRate = 10;

const hit = (time: number, a: number, b: number): Hit => ({ time, bots: [a, b] });
const bot = (id: number, x: number, y: number, fields: Partial<SceneBot> = {}): SceneBot => ({ id, entry: id - 1, x, y, heading: 0, hitPoints: 100, disabled: false, ...fields });
const scene = (time: number, bots: readonly SceneBot[]): Scene => ({ time, bots, projectiles: [], effects: [], destroyedObstacles: new Set() });

describe("engagement", () => {
  const hits = [hit(9.5, 1, 2), hit(20.5, 3, 1), hit(25.5, 2, 3), hit(40.5, 1, 4)];

  it("links the Bots a hit struck, either way, for 3 simulated seconds", () => {
    expect([...engagedBots(hits, 1, 9, tickRate)]).toEqual([]);
    expect([...engagedBots(hits, 1, 9.5, tickRate)]).toEqual([2]);
    expect([...engagedBots(hits, 1, 25, tickRate)].sort()).toEqual([2, 3]);
    expect([...engagedBots(hits, 1, 39.5, tickRate)]).toEqual([3]);
    expect([...engagedBots(hits, 1, 50.5, tickRate)]).toEqual([4]);
    expect([...engagedBots(hits, 1, 70.5, tickRate)]).toEqual([]);
  });

  it("leaves out hits between other Bots", () => {
    expect([...engagedBots(hits, 4, 26, tickRate)]).toEqual([]);
    expect([...engagedBots(hits, 2, 26, tickRate)].sort()).toEqual([1, 3]);
  });
});

describe("fitting the camera", () => {
  const limits = zoomLimits(map, 800, 600);

  it("frames the followed Bot alone at the default zoom", () => {
    expect(targetFraming(map, 800, 600, { x: 20, y: 30 }, [], 1)).toEqual({ scale: limits.default, offsetX: 0, offsetY: 0 });
  });

  it("zooms out to fit the engaged Bots, centred between them", () => {
    const framing = targetFraming(map, 800, 600, { x: 20, y: 30 }, [{ x: 50, y: 30 }], 1);
    // 30 m apart plus a 3 m margin each side: 36 m across 800 px.
    expect(framing.scale).toBeCloseTo(800 / 36, 9);
    expect(framing).toMatchObject({ offsetX: 15, offsetY: 0 });
  });

  it("never zooms in past the default to fit close Bots", () => {
    expect(targetFraming(map, 800, 600, { x: 20, y: 30 }, [{ x: 21, y: 30 }], 1).scale).toBe(limits.default);
  });

  it("never zooms out beyond minimum zoom", () => {
    expect(targetFraming(map, 800, 600, { x: 0, y: 0 }, [{ x: 500, y: 500 }], 1).scale).toBe(limits.min);
  });

  it("scales the framing by the zoom by hand, within the limits", () => {
    expect(targetFraming(map, 800, 600, { x: 20, y: 30 }, [], 2).scale).toBe(limits.default * 2);
    expect(targetFraming(map, 800, 600, { x: 20, y: 30 }, [], 100).scale).toBe(limits.max);
  });

  it("eases towards the framing and snaps once close", () => {
    const from = { scale: 10, offsetX: 0, offsetY: 0 };
    const to = { scale: 40, offsetX: 8, offsetY: -4 };
    const step = ease(from, to, 0.1);
    expect(step.scale).toBeGreaterThan(10);
    expect(step.scale).toBeLessThan(40);
    expect(step.offsetX).toBeGreaterThan(0);
    expect(step.offsetX).toBeLessThan(8);
    let framing = from;
    for (let i = 0; i < 200; i++) framing = ease(framing, to, 0.05);
    expect(framing).toEqual(to);
  });
});

describe("following a Bot", () => {
  const view: View = { centerX: 40, centerY: 30, scale: 40, width: 800, height: 600 };
  const start: Camera = follow({ view }, 1);
  const settle = (camera: Camera, at: Scene, hits: readonly Hit[] = []) => {
    let c = camera;
    for (let i = 0; i < 400; i++) c = followStep(c, map, at, hits, tickRate, 0.05);
    return c;
  };

  it("glides to the followed Bot and comes to rest on it", () => {
    const at = scene(5, [bot(1, 20, 30), bot(2, 60, 30)]);
    const first = followStep(start, map, at, [], tickRate, 0.016);
    expect(first.view.centerX).toBeLessThan(40);
    expect(first.view.centerX).toBeGreaterThan(20);
    const rested = settle(start, at);
    expect(rested.view).toMatchObject({ centerX: 20, centerY: 30, scale: zoomLimits(map, 800, 600).default });
    expect(rested.following?.bot).toBe(1);
    expect(followStep(rested, map, at, [], tickRate, 0.016)).toBe(rested);
  });

  it("fits an engaged Bot, and eases back to the default once it is no longer engaged", () => {
    const hits = [hit(4.5, 2, 1)];
    // From resting on the followed Bot, it stays in view all the while.
    let camera = settle(start, scene(4, [bot(1, 20, 30), bot(2, 50, 30)]), hits);
    for (let i = 0; i < 100; i++) {
      camera = followStep(camera, map, scene(5, [bot(1, 20, 30), bot(2, 50, 30)]), hits, tickRate, 0.05);
      const shown = viewBounds(camera.view);
      expect(20).toBeGreaterThanOrEqual(shown.minX);
      expect(20).toBeLessThanOrEqual(shown.maxX);
    }
    const engaged = settle(camera, scene(5, [bot(1, 20, 30), bot(2, 50, 30)]), hits);
    const shown = viewBounds(engaged.view);
    expect(shown.minX).toBeLessThanOrEqual(20);
    expect(shown.maxX).toBeGreaterThanOrEqual(50);
    const later = settle(engaged, scene(40, [bot(1, 20, 30), bot(2, 50, 30)]), hits);
    expect(later.view).toMatchObject({ centerX: 20, scale: zoomLimits(map, 800, 600).default });
  });

  it("stops when the followed Bot is Disabled, leaving the camera where it is", () => {
    const camera = settle(start, scene(5, [bot(1, 20, 30)]));
    const after = followStep(camera, map, scene(6, [bot(1, 21, 30, { disabled: true })]), [], tickRate, 0.016);
    expect(after).toEqual({ view: camera.view });
  });

  it("keeps following when zoomed by hand, and keeps that zoom", () => {
    const camera = settle(start, scene(5, [bot(1, 20, 30)]));
    const zoomed = zoomFollowing(camera, map, 2);
    expect(zoomed.following).toEqual({ bot: 1, zoom: 2 });
    expect(zoomed.view.scale).toBe(camera.view.scale * 2);
    expect(settle(zoomed, scene(6, [bot(1, 20, 30)])).view.scale).toBe(camera.view.scale * 2);
    // At maximum zoom, zooming further in changes nothing.
    const max = zoomLimits(map, 800, 600).max;
    const atMax = zoomFollowing(zoomed, map, 1000);
    expect(atMax.view.scale).toBe(max);
    expect(zoomFollowing(atMax, map, 2).following?.zoom).toBe(atMax.following?.zoom);
  });
});

describe("clicking a Bot", () => {
  const at = scene(0, [bot(1, 10, 10), bot(2, 11, 10)]);

  it("finds the nearest Bot whose drawing covers the point", () => {
    expect(botAt(at, { x: 10.6, y: 10 }, () => 1)).toBe(2);
    expect(botAt(at, { x: 9.5, y: 10 }, () => 1)).toBe(1);
    expect(botAt(at, { x: 30, y: 10 }, () => 1)).toBeUndefined();
  });
});

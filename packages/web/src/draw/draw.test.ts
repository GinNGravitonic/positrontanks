import { validateMap, validateRuleset, type Build, type MapFormat1, type Ruleset } from "@positrontanks/ruleset-data";
import fourCornersJson from "@positrontanks/ruleset-data/maps/four-corners.json";
import r1Json from "@positrontanks/ruleset-data/rulesets/r1.json";
import { describe, expect, it } from "vitest";
import { botBounds, botParts, componentCorners, drawBot, type BotParts } from "./bot.js";
import { entryColor, terrainColor } from "./colors.js";
import type { Context } from "./context.js";
import { mapToScreen, type View } from "./geometry.js";
import { drawMap } from "./map.js";

const r1: Ruleset = (() => {
  const result = validateRuleset(r1Json);
  if (!result.ok) throw new Error("r1 is invalid");
  return result.ruleset;
})();

const fourCorners: MapFormat1 = (() => {
  const result = validateMap(fourCornersJson);
  if (!result.ok) throw new Error("four-corners is invalid");
  return result.map;
})();

const noArmor = { front: null, left: null, right: null, rear: null };

function parts(build: Build): BotParts {
  const result = botParts(r1, build);
  if (result === undefined) throw new Error("unknown Chassis");
  return result;
}

const brawler = parts({ chassis: "brawler", components: { nose: "saw", rightGun: "pelletGun", leftDrive: "tracks" }, armor: noArmor });

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
}

/** A Context that records every method call with the fill style at the time. */
function recorder(): { readonly ctx: Context; readonly calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { fillStyle: "#000000" };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args, fillStyle: target.fillStyle });
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as Context;
  return { ctx, calls };
}

const view: View = { centerX: 0, centerY: 0, scale: 100, width: 400, height: 400 };

describe("botParts", () => {
  it("mounts the Build's Components at their Slots, in Slot order, leaving out empty Slots", () => {
    expect(brawler.chassis.id).toBe("brawler");
    expect(brawler.mounted.map((m) => [m.slot.id, m.component.id])).toEqual([
      ["nose", "saw"],
      ["rightGun", "pelletGun"],
      ["leftDrive", "tracks"],
    ]);
  });

  it("leaves out unknown Components, and gives up on an unknown Chassis", () => {
    expect(parts({ chassis: "scout", components: { gun: "nope" }, armor: noArmor }).mounted).toEqual([]);
    expect(botParts(r1, { chassis: "nope", components: {}, armor: noArmor })).toBeUndefined();
  });
});

describe("Component placement", () => {
  const box = (slotId: string) => {
    const m = brawler.mounted.find((x) => x.slot.id === slotId);
    if (m === undefined) throw new Error(slotId);
    return componentCorners(m);
  };

  it("runs a forward Component ahead of its Slot", () => {
    // saw: 0.4 long, 0.4 wide, at the nose (0, -0.9) facing 0.
    const corners = box("nose");
    expect(Math.min(...corners.map((p) => p.y))).toBeCloseTo(-1.3, 9);
    expect(Math.max(...corners.map((p) => p.y))).toBeCloseTo(-0.9, 9);
    expect(Math.min(...corners.map((p) => p.x))).toBeCloseTo(-0.2, 9);
    expect(Math.max(...corners.map((p) => p.x))).toBeCloseTo(0.2, 9);
  });

  it("turns a side Component with its Slot direction", () => {
    // pelletGun: 0.35 long, 0.1 wide, at (0.7, 0) facing 90: it sticks out to the right.
    const corners = box("rightGun");
    expect(Math.min(...corners.map((p) => p.x))).toBeCloseTo(0.7, 9);
    expect(Math.max(...corners.map((p) => p.x))).toBeCloseTo(1.05, 9);
    expect(Math.min(...corners.map((p) => p.y))).toBeCloseTo(-0.05, 9);
    expect(Math.max(...corners.map((p) => p.y))).toBeCloseTo(0.05, 9);
  });

  it("runs a rear-facing motor back from its Slot", () => {
    // tracks: 0.4 long, 0.9 wide, at (-0.5, 0.5) facing 180.
    const corners = box("leftDrive");
    expect(Math.min(...corners.map((p) => p.y))).toBeCloseTo(0.5, 9);
    expect(Math.max(...corners.map((p) => p.y))).toBeCloseTo(0.9, 9);
    expect(Math.min(...corners.map((p) => p.x))).toBeCloseTo(-0.95, 9);
  });

  it("bounds the Bot by its Chassis and every Component", () => {
    const b = botBounds(brawler);
    expect(b.minX).toBeCloseTo(-0.95, 9);
    expect(b.maxX).toBeCloseTo(1.05, 9);
    expect(b.minY).toBeCloseTo(-1.3, 9);
    expect(b.maxY).toBeCloseTo(0.9, 9);
  });
});

describe("drawBot", () => {
  it("draws motors under the Chassis and other Components over it, in its Entry color", () => {
    const { ctx, calls } = recorder();
    drawBot(ctx, view, { parts: brawler, pose: { x: 0, y: 0, heading: 0 }, color: entryColor(1) });
    const fills = calls.filter((c) => c.name === "fill").map((c) => c.fillStyle);
    expect(fills).toEqual(["#262626", entryColor(1), "#3d3d3d", "#3d3d3d"]);
  });

  it("draws a Disabled Bot grey", () => {
    const { ctx, calls } = recorder();
    drawBot(ctx, view, { parts: brawler, pose: { x: 0, y: 0, heading: 0 }, color: entryColor(1), disabled: true });
    expect(calls.filter((c) => c.name === "fill").map((c) => c.fillStyle)).toContain("#8a8a8a");
    expect(calls.filter((c) => c.name === "fill").map((c) => c.fillStyle)).not.toContain(entryColor(1));
  });

  it("labels the Bot with its name just below where it reaches, in screen pixels", () => {
    const { ctx, calls } = recorder();
    drawBot(ctx, view, { parts: brawler, pose: { x: 1, y: 0.5, heading: 90 }, color: entryColor(0), name: "Ada" });
    const text = calls.find((c) => c.name === "fillText");
    const reach = Math.hypot(1.05, 1.3);
    const below = mapToScreen(view, { x: 1, y: 0.5 + reach });
    expect(text?.args[0]).toBe("Ada");
    expect(text?.args[1]).toBeCloseTo(below.x, 9);
    expect(text?.args[2]).toBeCloseTo(below.y + 3, 9);
  });

  it("draws artwork in place of the placeholder when it resolves", () => {
    const { ctx, calls } = recorder();
    const image = {} as CanvasImageSource;
    const juggernaut = { ...parts({ chassis: "juggernaut", components: {}, armor: noArmor }) };
    const withArt = { ...juggernaut, chassis: { ...juggernaut.chassis, artwork: "art/juggernaut.svg" } };
    drawBot(ctx, view, { parts: withArt, pose: { x: 0, y: 0, heading: 0 }, color: entryColor(0) }, (ref) =>
      ref === "art/juggernaut.svg" ? image : undefined,
    );
    expect(calls.filter((c) => c.name === "drawImage")).toEqual([
      { name: "drawImage", args: [image, -0.9, -1.2, 1.8, 2.4], fillStyle: expect.anything() as unknown },
    ]);
    expect(calls.filter((c) => c.name === "fill")).toEqual([]);
  });
});

describe("drawMap", () => {
  it("draws the base Terrain, then each Terrain Region, Obstacle and Spawn Zone", () => {
    const { ctx, calls } = recorder();
    drawMap(ctx, view, fourCorners);
    const fills = calls.filter((c) => c.name === "fill").map((c) => c.fillStyle);
    expect(fills).toEqual([
      terrainColor("sand"),
      terrainColor("road"),
      terrainColor("road"),
      "#4a4a4a",
      "#4a4a4a",
      "#4a4a4a",
      "#8d6e4f",
      entryColor(0),
      entryColor(1),
      entryColor(2),
      entryColor(3),
    ]);
    // The circle Obstacles and Spawn Zones are arcs at their centres, in Map meters.
    expect(calls.filter((c) => c.name === "arc").map((c) => c.args.slice(0, 3))).toEqual([
      [20, 40, 3],
      [60, 40, 3],
      [40, 15, 1],
      [10, 10, 7],
      [70, 10, 7],
      [70, 70, 7],
      [10, 70, 5],
    ]);
  });

  it("can leave out Spawn Zones", () => {
    const { ctx, calls } = recorder();
    drawMap(ctx, view, fourCorners, { spawnZones: false });
    expect(calls.filter((c) => c.name === "fill")).toHaveLength(7);
  });

  it("colors an unknown Terrain from its name", () => {
    expect(terrainColor("lava")).toBe(terrainColor("lava"));
    expect(terrainColor("lava")).not.toBe(terrainColor("snow"));
  });
});

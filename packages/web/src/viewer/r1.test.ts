import { replayGame, replayOf, type BotFrame, type GameRecord, type Replay, type ReplayTick, type TickEvent } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import type { MapFormat1 } from "@positrontanks/ruleset-data";
import duelJson from "@positrontanks/ruleset-data/maps/duel.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { EFFECT_SECONDS, eventTime, interpolateBots, lerpHeading, loadR1Replay } from "./r1.js";

const duel = duelJson as MapFormat1;
const build = { chassis: "scout", components: {}, armor: { front: null, left: null, right: null, rear: null } };

const bot = (id: number, fields: Partial<BotFrame> = {}): BotFrame => ({ id, x: 10, y: 10, heading: 0, speed: 0, hitPoints: 100, status: "active", ...fields });

function tick(n: number, bots: readonly BotFrame[], events: readonly TickEvent[] = [], projectiles: ReplayTick["projectiles"] = []): ReplayTick {
  return { tick: n, events, bots, projectiles };
}

/** A Replay on the duel Map at 10 Ticks a second; Bot 1 is Ada's, Bot 2 Bob's. */
function replay(ticks: readonly ReplayTick[], map: MapFormat1 = duel): Replay {
  return {
    ruleset: "r1",
    tickRate: 10,
    map,
    timeLimitTicks: 1200,
    entries: [
      { player: "p-ada", bots: [{ id: 1, name: "Ada", build }] },
      { player: "p-bob", bots: [{ id: 2, name: "Bob", build }] },
    ],
    ticks,
    result: null,
  };
}

describe("interpolating between Ticks", () => {
  const entryOf = new Map([
    [1, 0],
    [2, 1],
  ]);

  it("moves a Bot straight from one Tick's position to the next", () => {
    const [b] = interpolateBots([bot(1, { x: 10, y: 20 })], [bot(1, { x: 12, y: 16 })], 0.25, entryOf);
    expect(b).toMatchObject({ id: 1, entry: 0, x: 10.5, y: 19 });
  });

  it("turns the short way round", () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(10, 350, 0.25)).toBeCloseTo(5, 9);
    expect(lerpHeading(90, 270, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(0, 90, 1)).toBeCloseTo(90, 9);
  });

  it("changes Hit Points and Disabled halfway through the Tick", () => {
    const before = [bot(2, { hitPoints: 30 })];
    const after = [bot(2, { hitPoints: 0, status: "disabled" })];
    expect(interpolateBots(before, after, 0.4, entryOf)[0]).toMatchObject({ entry: 1, hitPoints: 30, disabled: false });
    expect(interpolateBots(before, after, 0.5, entryOf)[0]).toMatchObject({ hitPoints: 0, disabled: true });
  });
});

describe("an r1 Replay's Scenes", () => {
  const fired: TickEvent = { type: "fired", tick: 2, bot: 1, weapon: "gun", category: "projectile", from: { x: 10, y: 10 }, absBearing: 90, projectile: 7 };
  const ticks = [
    tick(0, [bot(1), bot(2, { x: 20 })]),
    tick(1, [bot(1, { x: 11 }), bot(2, { x: 20 })]),
    tick(2, [bot(1, { x: 12 }), bot(2, { x: 20 })], [fired], [{ id: 7, x: 11, y: 10 }]),
    tick(3, [bot(1, { x: 12 }), bot(2, { x: 20 })], [], [{ id: 7, x: 13, y: 10 }]),
    tick(4, [bot(1, { x: 12 }), bot(2, { x: 20, hitPoints: 80 })], [
      { type: "impact", tick: 4, bot: 1, weapon: "gun", projectile: 7, point: { x: 19.5, y: 10 }, target: { kind: "bot", id: 2 } },
    ]),
    tick(5, [bot(1, { x: 12 }), bot(2, { x: 20, hitPoints: 80 })]),
    tick(6, [bot(1, { x: 12 }), bot(2, { x: 20, hitPoints: 80 })]),
  ];
  const viewer = loadR1Replay(replay(ticks));

  it("ends at the last Tick, and keeps time within the Game", () => {
    expect(viewer.lastTick).toBe(6);
    expect(viewer.scene(-1).time).toBe(0);
    expect(viewer.scene(9).time).toBe(6);
    expect(viewer.scene(9).bots.map((b) => b.hitPoints)).toEqual([100, 80]);
  });

  it("shows each Tick's frame at its end, and between Ticks something in between", () => {
    expect(viewer.scene(1).bots[0]?.x).toBe(11);
    expect(viewer.scene(1.5).bots[0]?.x).toBe(11.5);
  });

  it("flies a new Projectile from where it was fired, and drops it once it has ended", () => {
    expect(viewer.scene(1).projectiles).toEqual([]);
    expect(viewer.scene(1.5).projectiles).toEqual([{ id: 7, x: 10.5, y: 10 }]);
    expect(viewer.scene(2.5).projectiles).toEqual([{ id: 7, x: 12, y: 10 }]);
    expect(viewer.scene(3.5).projectiles).toEqual([]);
  });

  it("draws an event from halfway through its Tick, for a short while", () => {
    const duration = EFFECT_SECONDS * 10;
    expect(eventTime(2)).toBe(1.5);
    expect(viewer.scene(1.4).effects).toEqual([]);
    expect(viewer.scene(1.5).effects).toEqual([{ kind: "muzzle", at: { x: 10, y: 10 }, heading: 90, age: 0 }]);
    expect(viewer.scene(3.5).effects).toEqual([
      { kind: "muzzle", at: { x: 10, y: 10 }, heading: 90, age: 2 / duration },
      { kind: "impact", at: { x: 19.5, y: 10 }, hit: true, age: 0 },
    ]);
    expect(viewer.scene(1.5 + duration / 2).effects[0]).toMatchObject({ kind: "muzzle", age: 0.5 });
    expect(viewer.scene(1.5 + duration).effects.filter((e) => e.kind === "muzzle")).toEqual([]);
  });

  it("draws a beam from where it was fired to where it ended, and a ram where it struck", () => {
    const beam = loadR1Replay(
      replay([
        tick(0, [bot(1), bot(2, { x: 20 })]),
        tick(1, [bot(1), bot(2, { x: 20 })], [
          { ...fired, tick: 1, category: "beam", projectile: null },
          { type: "impact", tick: 1, bot: 1, weapon: "gun", projectile: null, point: { x: 19, y: 10 }, target: { kind: "bot", id: 2 } },
          { type: "collision", tick: 1, bot: 2, with: { kind: "boundary" }, closingSpeed: 0, point: { x: 20, y: 0 } },
          { type: "collision", tick: 1, bot: 1, with: { kind: "bot", id: 2 }, closingSpeed: 3, point: { x: 15, y: 10 } },
        ]),
      ]),
    );
    expect(beam.scene(0.5).effects.map((e) => e.kind)).toEqual(["muzzle", "beam", "collision"]);
    expect(beam.scene(0.5).effects[1]).toEqual({ kind: "beam", from: { x: 10, y: 10 }, to: { x: 19, y: 10 }, age: 0 });
  });

  it("removes a destroyed Obstacle halfway through its Tick, with an explosion at its centre", () => {
    const map: MapFormat1 = { ...duel, obstacles: [{ id: "crate", shape: "circle", x: 30, y: 12, radius: 1, destructible: true, hitPoints: 50 }] };
    const destroyed = loadR1Replay(
      replay([tick(0, [bot(1), bot(2)]), tick(1, [bot(1), bot(2)], [{ type: "obstacleDestroyed", tick: 1, obstacle: "crate" }])], map),
    );
    expect([...destroyed.scene(0.4).destroyedObstacles]).toEqual([]);
    expect([...destroyed.scene(0.5).destroyedObstacles]).toEqual(["crate"]);
    expect(destroyed.scene(0.5).effects).toEqual([{ kind: "explosion", at: { x: 30, y: 12 }, age: 0 }]);
  });

  it("refuses what is not an r1 Replay", () => {
    expect(() => loadR1Replay({ ruleset: "r1" })).toThrow("not an r1 Replay");
    expect(() => loadR1Replay(replay([]))).toThrow("no Ticks");
    expect(() => loadR1Replay(replay([tick(1, [])]))).toThrow("numbered from 0");
  });
});

describe("a golden Game's Replay", () => {
  const game = replayGame(duelLastStanding.record as unknown as GameRecord, loadRuleset("r1"));
  const viewer = loadR1Replay(JSON.parse(JSON.stringify(replayOf(game))));

  it("plays to its last Tick, every Bot drawn throughout, and ends with a Bot Disabled", () => {
    expect(viewer.lastTick).toBe(game.world.tick);
    for (let t = 0; t <= viewer.lastTick; t += 0.37) {
      const scene = viewer.scene(t);
      expect(scene.bots).toHaveLength(2);
      for (const b of scene.bots) expect(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.heading)).toBe(true);
    }
    expect(viewer.scene(viewer.lastTick).bots.some((b) => b.disabled)).toBe(true);
  });

  it("draws its shots", () => {
    const kinds = new Set<string>();
    for (let t = 0; t <= viewer.lastTick; t += 0.5) for (const e of viewer.scene(t).effects) kinds.add(e.kind);
    expect(kinds.has("muzzle")).toBe(true);
    expect(kinds.has("explosion")).toBe(true);
  });
});

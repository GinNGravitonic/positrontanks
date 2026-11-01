import { describe, expect, it } from "vitest";
import type { DamageEvent, TickEvent } from "./events.js";
import { earlierTicks, type ReplayTick } from "./replay.js";

const at = { x: 0, y: 0 };

function shot(tick: number, from: number, to: number, dealt: number): DamageEvent {
  return {
    type: "damage",
    tick,
    target: { kind: "bot", id: to },
    source: { kind: "weapon", bot: from, weapon: "w1", category: "projectile" },
    raw: dealt,
    absorbed: 0,
    dealt,
    side: "front",
    point: at,
    absorber: "chassis",
  };
}

function ram(tick: number, target: number, other: DamageEvent["source"], dealt: number): DamageEvent {
  return { ...shot(tick, 0, target, dealt), source: other };
}

const frame = (tick: number, events: readonly TickEvent[]): ReplayTick => ({ tick, events, bots: [], projectiles: [] });

describe("What earlier Ticks left behind", () => {
  const ticks = [
    frame(0, []),
    frame(1, [shot(1, 1, 2, 10), { type: "obstacleDestroyed", tick: 1, obstacle: "crate" }]),
    frame(2, [
      shot(2, 1, 2, 5),
      ram(2, 1, { kind: "collision", with: { kind: "bot", id: 2 } }, 3),
      ram(2, 2, { kind: "collision", with: { kind: "boundary" } }, 4),
      ram(2, 2, { kind: "collision", with: { kind: "wreck", id: 3 } }, 1),
      shot(2, 3, 1, 0),
      { type: "disabled", tick: 2, bot: 2, cause: "destroyed" },
    ]),
    frame(3, [shot(3, 1, 3, 7), { type: "obstacleDestroyed", tick: 3, obstacle: "wall" }]),
  ];

  it("keeps Obstacles destroyed and Bots Disabled, and sums damage per dealer and target", () => {
    expect(earlierTicks(ticks, 3)).toEqual({
      beforeTick: 3,
      obstaclesDestroyed: [{ type: "obstacleDestroyed", tick: 1, obstacle: "crate" }],
      disabled: [{ type: "disabled", tick: 2, bot: 2, cause: "destroyed" }],
      damage: [
        { dealer: 1, target: 2, dealt: 15 },
        { dealer: 2, target: 1, dealt: 3 },
        { dealer: null, target: 2, dealt: 5 },
      ],
    });
  });

  it("is empty before the first Tick", () => {
    expect(earlierTicks(ticks, 0)).toEqual({ beforeTick: 0, obstaclesDestroyed: [], disabled: [], damage: [] });
  });

  it("does not grow with the number of Ticks", () => {
    const long = Array.from({ length: 1000 }, (_, tick) => frame(tick, [shot(tick, 1, 2, 1), shot(tick, 2, 1, 2)]));
    expect(earlierTicks(long, 1000).damage).toEqual([
      { dealer: 1, target: 2, dealt: 1000 },
      { dealer: 2, target: 1, dealt: 2000 },
    ]);
  });
});

import { replayGame, replayOf, type GameRecord } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import iceAndMudTeams from "@positrontanks/engine-r1/golden/ice-and-mud-teams.json";
import programFailures from "@positrontanks/engine-r1/golden/program-failures.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { botFigures, disabledCauseText } from "./figures.js";
import { loadR1Replay } from "./r1.js";
import type { Damage, ViewerEntry } from "./scene.js";

const build = { chassis: "scout", components: {}, armor: { front: null, left: null, right: null, rear: null } };
/** Bots 1 and 2 are one Entry's, Bot 3 another's. */
const entries: ViewerEntry[] = [
  { player: "p-ada", bots: [{ id: 1, name: "A1", build }, { id: 2, name: "A2", build }] },
  { player: "p-bob", bots: [{ id: 3, name: "B1", build }] },
];
const damage: Damage[] = [
  { time: 4.5, target: 3, dealer: 1, amount: 10 },
  { time: 6.5, target: 1, dealer: 3, amount: 7 },
  { time: 7.5, target: 2, dealer: 1, amount: 5 },
  { time: 8.5, target: 1, dealer: null, amount: 2 },
  { time: 9.5, target: 3, dealer: 1, amount: 4.5 },
];
const replay = { entries, damage, disablements: [{ time: 9.5, bot: 3, cause: "destroyed" }] };

describe("per-Bot figures", () => {
  it("count only the events that have happened by the time asked", () => {
    expect(botFigures(replay, 1, 0)).toEqual({ dealtToFoes: 0, taken: 0 });
    expect(botFigures(replay, 1, 4.4)).toEqual({ dealtToFoes: 0, taken: 0 });
    expect(botFigures(replay, 1, 4.5)).toEqual({ dealtToFoes: 10, taken: 0 });
    expect(botFigures(replay, 1, 7)).toEqual({ dealtToFoes: 10, taken: 7 });
    expect(botFigures(replay, 1, 20)).toEqual({ dealtToFoes: 14.5, taken: 9 });
  });

  it("deal nothing to a Foe by hitting a Friend, though the Friend takes it", () => {
    expect(botFigures(replay, 2, 20)).toEqual({ dealtToFoes: 0, taken: 5 });
  });

  it("count damage dealt by no Bot as taken", () => {
    expect(botFigures(replay, 1, 8.5).taken).toBe(9);
  });

  it("say when a Bot is Disabled and why, from then on", () => {
    expect(botFigures(replay, 3, 9).disabled).toBeUndefined();
    expect(botFigures(replay, 3, 9.5)).toEqual({ dealtToFoes: 7, taken: 14.5, disabled: { time: 9.5, bot: 3, cause: "destroyed" } });
    expect(disabledCauseText("destroyed")).toBe("destroyed");
    expect(disabledCauseText("programHalted")).toBe("its Program halted");
  });
});

describe("per-Bot figures of a played Game", () => {
  const golden = (record: unknown) => replayOf(replayGame(record as GameRecord, loadRuleset("r1")));
  const games = { duelLastStanding, iceAndMudTeams, programFailures };

  for (const [name, { record }] of Object.entries(games)) {
    it(`add up to each Player's Foe damage in its result, at the end (${name})`, () => {
      const r1 = golden(record);
      const viewer = loadR1Replay(JSON.parse(JSON.stringify(r1)));
      const totals = new Map<string, number>();
      for (const entry of viewer.entries) {
        for (const bot of entry.bots) totals.set(entry.player, (totals.get(entry.player) ?? 0) + botFigures(viewer, bot.id, viewer.lastTick).dealtToFoes);
      }
      for (const standing of r1.result?.standings ?? []) expect(totals.get(standing.player) ?? 0).toBeCloseTo(standing.foeDamage, 6);
    });

    it(`match each Bot's Hit Points and status in the final frame (${name})`, () => {
      const r1 = golden(record);
      const viewer = loadR1Replay(JSON.parse(JSON.stringify(r1)));
      const final = r1.ticks.at(-1);
      const start = r1.ticks[0];
      for (const frame of final?.bots ?? []) {
        const figures = botFigures(viewer, frame.id, viewer.lastTick);
        const first = start?.bots.find((b) => b.id === frame.id);
        expect(figures.taken).toBeCloseTo((first?.hitPoints ?? 0) - frame.hitPoints, 6);
        expect(figures.disabled !== undefined).toBe(frame.status === "disabled");
      }
    });
  }
});

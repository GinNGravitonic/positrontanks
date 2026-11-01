import { replayGame, replayOf, type GameRecord, type Replay } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import fourCornersTimeLimit from "@positrontanks/engine-r1/golden/four-corners-time-limit.json";
import iceAndMudTeams from "@positrontanks/engine-r1/golden/ice-and-mud-teams.json";
import mutualDestructionDraw from "@positrontanks/engine-r1/golden/mutual-destruction-draw.json";
import programFailures from "@positrontanks/engine-r1/golden/program-failures.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../hooks.js";
import { createServices } from "../services.js";
import { fakeApi, memoryHistory, memoryStorage } from "../test-platform.js";
import { disabledTick, entryFigures } from "../viewer/figures.js";
import { loadR1Replay } from "../viewer/r1.js";
import { figureText } from "./bot-inset.js";
import { GameOver, outcomeText, type GameResult } from "./game-over.js";

const ruleset = loadRuleset("r1");
const services = createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/") });
const goldens = { duelLastStanding, fourCornersTimeLimit, iceAndMudTeams, mutualDestructionDraw, programFailures };

function played(golden: { readonly record: unknown }) {
  const r1 = JSON.parse(JSON.stringify(replayOf(replayGame(golden.record as GameRecord, ruleset)))) as Replay;
  return { r1, replay: loadR1Replay(r1) };
}

/** The usernames the tests give Players: their ids, with `_bot` after. */
const usernameOf = (player: string) => `${player}_bot`;

/** The engine's result as the API gives it in a Game. */
function apiResult(r1: Replay): GameResult {
  const result = r1.result;
  if (result === null) throw new Error("expected a result");
  const ends = { lastStanding: "last_standing", noneStanding: "none_standing", timeLimit: "time_limit" } as const;
  const decided = { survival: "survival", foeDamage: "foe_damage", hitPoints: "hit_points" } as const;
  return {
    tick: result.tick,
    end: ends[result.end],
    winner: result.winner === null ? null : { id: result.winner, username: usernameOf(result.winner) },
    decidedBy: result.decidedBy === null ? null : decided[result.decidedBy],
  };
}

function render(golden: { readonly record: unknown }) {
  const { r1, replay } = played(golden);
  const usernames = new Map(replay.entries.map((entry) => [entry.player, usernameOf(entry.player)]));
  const html = renderToString(
    <ServicesProvider services={services}>
      <GameOver result={apiResult(r1)} replay={replay} usernames={usernames} onWatchAgain={() => undefined} />
    </ServicesProvider>,
  );
  return { r1, replay, html };
}

describe("each Entry's figures at the end", () => {
  for (const [name, golden] of Object.entries(goldens)) {
    it(`are the engine's standings in its result (${name})`, () => {
      const { r1, replay } = played(golden);
      const figures = entryFigures(replay);
      const standings = r1.result?.standings ?? [];
      expect(figures.map((f) => f.player)).toEqual(standings.map((s) => s.player));
      figures.forEach((f, i) => {
        const s = standings[i];
        expect(f.dealtToFoes).toBeCloseTo(s?.foeDamage ?? NaN, 6);
        expect(f.hitPoints).toBeCloseTo(s?.hitPoints ?? NaN, 6);
        expect(f.standing).toBe(s?.remaining);
      });
    });
  }
});

describe("the outcome", () => {
  const winner = { id: "p-ada", username: "ada_bot" };
  it("names the Winner and how the Game was decided", () => {
    expect(outcomeText({ tick: 812, end: "last_standing", winner, decidedBy: "survival" })).toEqual({
      title: "ada_bot wins",
      how: "ada_bot was the last standing.",
    });
    expect(outcomeText({ tick: 1200, end: "time_limit", winner, decidedBy: "foe_damage" }).how).toBe(
      "The time limit was reached; decided on damage dealt to Foes.",
    );
    expect(outcomeText({ tick: 900, end: "none_standing", winner, decidedBy: "hit_points" }).how).toBe(
      "No Bot was left standing; decided on remaining Hit Points, after a tie on damage dealt to Foes.",
    );
  });

  it("says a Draw is one, and why", () => {
    const draw = outcomeText({ tick: 49, end: "none_standing", winner: null, decidedBy: null });
    expect(draw.title).toBe("Draw");
    expect(draw.how).toMatch(/^No Bot was left standing, and the Players were tied/);
  });
});

describe("Game Over", () => {
  it("shows a last-standing win: the Winner, each Entry's figures and its Bots'", () => {
    const { r1, replay, html } = render(duelLastStanding);
    const winner = r1.result?.winner ?? "";
    expect(html).toContain(`${usernameOf(winner)} wins`);
    expect(html).toContain(`Tick ${String(r1.result?.tick)}`);
    expect(html).toContain(">Winner</span>");
    for (const entry of replay.entries) {
      expect(html).toContain(`${usernameOf(entry.player)}&#x27;s Emblem`);
      for (const bot of entry.bots) expect(html).toContain(`>${bot.name}</th>`);
    }
    for (const f of entryFigures(replay)) expect(html).toContain(`<td>${figureText(f.dealtToFoes)}</td>`);
    const disabled = replay.disablements[0];
    if (disabled === undefined) throw new Error("expected a Bot Disabled");
    expect(html).toContain(`Disabled in Tick ${String(disabledTick(disabled))}: destroyed`);
    expect(html).toContain("Still standing");
    expect(html).toContain("All Disabled");
  });

  it("shows a Draw, with no Winner and no Entry standing", () => {
    const { html } = render(mutualDestructionDraw);
    expect(html).toContain("<h3>Draw</h3>");
    expect(html).not.toContain(">Winner</span>");
    expect(html).not.toContain("Still standing");
  });

  it("shows a win at the time limit, with the Entries still standing", () => {
    const { r1, html } = render(fourCornersTimeLimit);
    expect(r1.result?.end).toBe("timeLimit");
    expect(html).toContain(`${usernameOf(r1.result?.winner ?? "")} wins`);
    expect(html).toContain("The time limit was reached; decided on");
    expect(html).toContain("Still standing");
  });

  it("offers to watch again and to go back to the Games", () => {
    const { html } = render(duelLastStanding);
    expect(html).toMatch(/<button type="button">Watch again<\/button>/);
    expect(html).toContain('href="/play/">Back to Games</a>');
  });

  it("puts a Bot Disabled in its Tick: its events happen halfway through it", () => {
    expect(disabledTick({ time: 11.5, bot: 1, cause: "destroyed" })).toBe(12);
    expect(disabledTick({ time: 0, bot: 1, cause: "programHalted" })).toBe(0);
  });
});

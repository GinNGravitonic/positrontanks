import { replayGame, replayOf, type GameRecord } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../hooks.js";
import { createServices } from "../services.js";
import { fakeApi, memoryHistory, memoryStorage } from "../test-platform.js";
import { botFigures } from "../viewer/figures.js";
import { clockText } from "../viewer/playback.js";
import { loadR1Replay } from "../viewer/r1.js";
import { BotInset, figureText } from "./bot-inset.js";
import { botLooks } from "./watch.js";

const ruleset = loadRuleset("r1");
const replay = loadR1Replay(JSON.parse(JSON.stringify(replayOf(replayGame(duelLastStanding.record as unknown as GameRecord, ruleset)))));
const looks = botLooks(replay, ruleset);
const [first, second] = replay.entries;
const players = new Map([[first?.player ?? "", { id: first?.player ?? "", username: "ada_bot", emblem: null }]]);
const services = createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/") });
const disabled = replay.disablements[0];
if (disabled === undefined) throw new Error("expected a Bot Disabled in the golden Game");

function render(bot: number, time: number, following = false) {
  return renderToString(
    <ServicesProvider services={services}>
      <BotInset
        replay={replay}
        catalog={ruleset}
        scene={replay.scene(time)}
        bot={bot}
        looks={looks.get(bot)}
        players={players}
        following={following}
        onFollow={() => undefined}
        onStopFollowing={() => undefined}
        onClose={() => undefined}
      />
    </ServicesProvider>,
  );
}

describe("the Bot inset", () => {
  const bot = first?.bots[0];
  if (bot === undefined) throw new Error("expected a Bot");
  const parts = looks.get(bot.id)?.parts;

  it("names the Bot, its Player and their Emblem, its Chassis and its Components", () => {
    const html = render(bot.id, 0);
    expect(html).toContain(bot.name);
    expect(html).toContain("ada_bot");
    expect(html).toContain(">AB</text>");
    expect(html).toContain(parts?.chassis.name);
    for (const { slot, component } of parts?.mounted ?? []) expect(html).toContain(`${slot.id}<!-- -->: <!-- -->${component.name}`);
  });

  it("falls back to the Player's id when their username is not known", () => {
    const other = second?.bots[0];
    if (other === undefined || second === undefined) throw new Error("expected a second Entry");
    expect(render(other.id, 0)).toContain(second.player);
  });

  it("shows Hit Points out of the Chassis's, Armor on each side and speed", () => {
    const html = render(bot.id, 0);
    const max = parts?.chassis.stats.hitPoints as number;
    expect(html).toContain(`<meter min="0" max="${String(max)}" value="${String(max)}">`);
    for (const side of ["front", "left", "right", "rear"]) expect(html).toContain(`${side}<!-- -->: `);
    expect(html).toContain("m/s");
  });

  it("shows the damage dealt to Foes and taken up to the current moment, and the status", () => {
    const victim = disabled.bot;
    const before = render(victim, disabled.time - 1);
    expect(before).toContain("Live");
    const after = render(victim, replay.lastTick);
    const figures = botFigures(replay, victim, replay.lastTick);
    expect(after).toContain(`Disabled at ${clockText(disabled.time, replay.tickRate)}: destroyed`);
    expect(after).toContain(`<dd>${figureText(figures.taken)}</dd>`);
    expect(figures.taken).toBeGreaterThan(0);
  });

  it("offers to follow a live Bot, or to stop following it, but not to follow a wreck", () => {
    expect(render(bot.id, 0)).toMatch(/<button type="button">Follow<\/button>/);
    expect(render(bot.id, 0, true)).toContain("Stop following");
    expect(render(disabled.bot, replay.lastTick)).toMatch(/<button type="button" disabled="">Follow<\/button>/);
  });

  it("shows whole figures as they are and others to one decimal place", () => {
    expect(figureText(40)).toBe("40");
    expect(figureText(12.345)).toBe("12.3");
  });
});

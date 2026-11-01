import { replayGame, replayOf, type GameRecord } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { matchGameRoute } from "./app.js";
import { ServicesProvider } from "./hooks.js";
import { loadReplay } from "./replays.js";
import { botLooks, iconsOf, ReplayControls, startingBot, WatchGame } from "./screens/watch.js";
import { createServices, signUp } from "./services.js";
import { fakeApi, memoryHistory, memoryStorage, testGame } from "./test-platform.js";

const golden = JSON.parse(JSON.stringify(replayOf(replayGame(duelLastStanding.record as unknown as GameRecord, loadRuleset("r1"))))) as unknown;
const finished = testGame({ state: "finished", startedAt: "2026-10-31T00:10:00.000Z", endedAt: "2026-10-31T00:12:00.000Z" });

async function signedIn(api: ReturnType<typeof fakeApi>) {
  const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history: memoryHistory("/play/") });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
  return services;
}

describe("loading a Finished Game's Replay", () => {
  it("reads it with its Ruleset's viewer, with the Ruleset's Parts Catalog", async () => {
    const api = fakeApi({ games: [finished], replays: { g1: golden } });
    const loaded = await loadReplay((await signedIn(api)).api, finished);
    if (loaded.kind !== "replay") throw new Error("expected a Replay");
    expect(api.requests).toContain("GET /games/g1/replay");
    expect(api.requests).toContain("GET /rulesets/r1/parts");
    expect(loaded.replay.lastTick).toBeGreaterThan(0);
    // Every Bot of the golden Game is drawn from the catalog, under its Bot Name.
    const looks = botLooks(loaded.replay, loaded.catalog);
    expect([...looks.values()].every((look) => look.parts !== undefined)).toBe(true);
    expect([...looks.values()].map((look) => look.name)).toEqual(loaded.replay.entries.flatMap((e) => e.bots.map((b) => b.name)));
  });

  it("asks for nothing for a Ruleset with no viewer, and says it is no longer supported", async () => {
    const old = { ...finished, rulesetVersion: "r0" };
    const api = fakeApi({ games: [old] });
    const services = await signedIn(api);
    const before = api.requests.length;
    expect(await loadReplay(services.api, old)).toEqual({ kind: "unsupported", version: "r0" });
    expect(api.requests.length).toBe(before);
  });
});

describe("the Watch screen", () => {
  const services = createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/") });
  const render = (game: Parameters<typeof WatchGame>[0]["game"]) =>
    renderToString(
      <ServicesProvider services={services}>
        <WatchGame game={game} />
      </ServicesProvider>,
    );

  it("is routed from a Game's watch link", () => {
    expect(matchGameRoute("/games/g1/watch")).toEqual({ id: "g1", sub: "watch" });
  });

  it("says why a Game that is not Finished has no Replay to show", () => {
    expect(render(testGame())).toContain("has not started yet");
    expect(render(testGame({ state: "cancelled", cancelReason: "initiator", endedAt: "2026-10-31T00:30:00.000Z" }))).toContain("It has no Replay");
  });

  it("joins a real-time Running Game live, and waits for an unthrottled one's Replay", () => {
    expect(render(testGame({ state: "running" }))).toContain("Joining the Game…");
    const waiting = render(testGame({ state: "running", pace: "unthrottled" }));
    expect(waiting).toContain("cannot be watched live");
    expect(waiting).toContain("shows the Replay as soon as it is");
  });

  it("starts on the signed-in Player's first Bot, or else the first Bot", async () => {
    const api = fakeApi({ games: [finished], replays: { g1: golden } });
    const loaded = await loadReplay((await signedIn(api)).api, finished);
    if (loaded.kind !== "replay") throw new Error("expected a Replay");
    const [first, second] = loaded.replay.entries;
    expect(startingBot(loaded.replay, second?.player)).toBe(second?.bots[0]?.id);
    expect(startingBot(loaded.replay, "nobody")).toBe(first?.bots[0]?.id);
  });
});

describe("the Replay time controls", () => {
  const render = (time: number, playing: boolean) =>
    renderToString(<ReplayControls playback={{ time, playing, speed: 1 }} tickRate={20} lastTick={1200} onChange={() => undefined} />);

  it("offer play or pause, a scrubber over the whole Game, every speed and Skip to result", () => {
    const html = render(0, true);
    expect(html).toContain(">Pause<");
    expect(html).toMatch(/type="range"[^>]*min="0"[^>]*max="1200"/);
    expect(html).toContain("0:00<!-- --> / <!-- -->1:00");
    for (const speed of ["0.25x", "0.5x", "1x", "2x", "4x"]) expect(html).toContain(`>${speed}</option>`);
    expect(html).toMatch(/<button type="button">Skip to result<\/button>/);
  });

  it("cannot skip once at the result", () => {
    const html = render(1200, false);
    expect(html).toContain(">Play<");
    expect(html).toMatch(/<button type="button" disabled="">Skip to result<\/button>/);
  });
});

describe("each Bot's Icon", () => {
  it("is its Entry Bot's, by Bot Name, and none when the Game does not show it", () => {
    const player = { id: "p-ada_bot", username: "ada_bot", emblem: null };
    const game = testGame({
      state: "running",
      entries: [
        { id: "e1", player, createdAt: "2026-10-31T00:05:00.000Z", bots: [{ name: "Hunter", icon: "i1" }, { name: "Tank", icon: null }, { name: "Scout" }] },
      ],
    });
    expect([...iconsOf(game)]).toEqual([
      ["Hunter", "i1"],
      ["Tank", null],
      ["Scout", null],
    ]);
  });
});

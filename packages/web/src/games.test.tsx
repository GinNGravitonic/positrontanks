import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { App, matchGameRoute } from "./app.js";
import {
  browseGames,
  cancelGame,
  cancelReasonText,
  filtersFromSearch,
  gameActions,
  getGame,
  myGames,
  problemText,
  resultText,
  searchFromFilters,
  statesFromSearch,
  withdrawEntry,
  type Game,
} from "./games.js";
import { ServicesProvider } from "./hooks.js";
import { GameView, type GameViewProps } from "./screens/game.js";
import { GameTable } from "./screens/games.js";
import { createServices, signUp } from "./services.js";
import { SESSION_STORAGE_KEY } from "./session.js";
import { fakeApi, memoryHistory, memoryStorage, testGame } from "./test-platform.js";

const ada = { id: "p-ada_bot", username: "ada_bot", emblem: null };
const bob = { id: "p-bob_bot", username: "bob_bot", emblem: null };
const entry = (id: string, player: { id: string; username: string; emblem: string | null }, bots: string[], cost?: number): Game["entries"][number] => ({
  id,
  player,
  createdAt: "2026-10-31T00:05:00.000Z",
  bots: bots.map((name) => ({ name })),
  ...(cost === undefined ? {} : { cost }),
});

/** Services signed in as `username` (password "correct horse") against `api`. */
async function signedIn(api: ReturnType<typeof fakeApi>, username: string, start = "/play/") {
  const history = memoryHistory(start);
  const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history });
  await signUp(services, { username, password: "correct horse" }, start.slice("/play".length));
  return services;
}

describe("browse filters in the route", () => {
  it("reads the filters from the query, dropping empty values and numbers that are not whole", () => {
    const search = new URLSearchParams("ruleset=r1&map=&players=4&minBudget=500&maxBudget=lots");
    expect(filtersFromSearch(search)).toEqual({ rulesetVersion: "r1", playerCount: 4, minPointBudget: 500 });
  });

  it("writes them back as the same query", () => {
    const filters = { rulesetVersion: "r1", mapId: "m 1", playerCount: 2, maxPointBudget: 900 };
    expect(searchFromFilters(filters).toString()).toBe("ruleset=r1&map=m+1&players=2&maxBudget=900");
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
  });

  it("reads My Games' states, in order, ignoring unknown ones", () => {
    expect(statesFromSearch(new URLSearchParams("state=finished,open,lost"))).toEqual(["open", "finished"]);
    expect(statesFromSearch(new URLSearchParams())).toEqual([]);
  });
});

describe("Games through the API", () => {
  const many = Array.from({ length: 30 }, (_, i) => testGame({ id: `g${String(i)}`, pointBudget: 500 + i * 10 }));

  it("browses Open Games a page at a time, with the filters as query parameters", async () => {
    const api = fakeApi({ games: [...many, testGame({ id: "done", state: "finished" })] });
    const services = await signedIn(api, "ada_bot");
    const first = await browseGames(services.api, { rulesetVersion: "r1", minPointBudget: 600 });
    expect(api.requests.at(-1)).toBe("GET /games?rulesetVersion=r1&minPointBudget=600&limit=25");
    expect(first.games).toHaveLength(20);
    expect(first.nextCursor).toBeNull();

    const all = await browseGames(services.api, {});
    expect(all.games).toHaveLength(25);
    const second = await browseGames(services.api, {}, all.nextCursor ?? "");
    expect(api.requests.at(-1)).toBe("GET /games?limit=25&cursor=25");
    expect(second.games.map((g) => g.id)).toEqual(["g25", "g26", "g27", "g28", "g29"]);
    expect(second.nextCursor).toBeNull();
  });

  it("lists My Games by state", async () => {
    const api = fakeApi({
      games: [
        testGame({ id: "mine-open" }),
        testGame({ id: "mine-finished", state: "finished" }),
        testGame({ id: "entered", initiator: bob, state: "running", entries: [entry("e1", ada, ["Hunter"])] }),
        testGame({ id: "theirs", initiator: bob }),
      ],
    });
    const services = await signedIn(api, "ada_bot");
    expect((await myGames(services.api, [])).games.map((g) => g.id)).toEqual(["mine-open", "mine-finished", "entered"]);
    expect((await myGames(services.api, ["open", "running"])).games.map((g) => g.id)).toEqual(["mine-open", "entered"]);
    expect(api.requests.at(-1)).toBe("GET /players/me/games?state=open%2Crunning&limit=25");
  });

  it("cancels an Open Game its Initiator cancels, and withdraws a Player's Entry", async () => {
    const api = fakeApi({ games: [testGame({ entries: [entry("e1", ada, ["Hunter"]), entry("e2", bob, ["Tank"])] })] });
    const services = await signedIn(api, "ada_bot");
    await withdrawEntry(services.api, "g1", "e1");
    expect(api.requests.at(-1)).toBe("DELETE /games/g1/entries/e1");
    expect((await getGame(services.api, "g1")).entries.map((e) => e.id)).toEqual(["e2"]);

    const cancelled = await cancelGame(services.api, "g1");
    expect(api.requests.at(-1)).toBe("POST /games/g1/cancel");
    expect(cancelled).toMatchObject({ state: "cancelled", cancelReason: "initiator" });
  });

  it("fails with the API's 409 when the Game is no longer Open", async () => {
    const api = fakeApi({ games: [testGame({ state: "running", entries: [entry("e1", ada, ["Hunter"])] })] });
    const services = await signedIn(api, "ada_bot");
    const cancelling = cancelGame(services.api, "g1");
    await expect(cancelling).rejects.toMatchObject({ status: 409, code: "game_not_open" });
    expect(problemText(await cancelling.catch((e: unknown) => e))).toBe("The Game is running, not open");
    await expect(withdrawEntry(services.api, "g1", "e1")).rejects.toMatchObject({ status: 409 });
  });
});

describe("gameActions", () => {
  it("lets a Player without an Entry enter, a Player with one withdraw it, and the Initiator cancel", () => {
    const game = testGame({ entries: [entry("e2", bob, ["Tank"])] });
    expect(gameActions(game, ada.id)).toEqual({ enter: true, cancel: true });
    expect(gameActions(game, bob.id)).toEqual({ enter: false, withdrawEntryId: "e2", cancel: false });
  });

  it("allows nothing once the Game is not Open", () => {
    expect(gameActions(testGame({ state: "running", entries: [entry("e1", ada, ["Hunter"])] }), ada.id)).toEqual({ enter: false, cancel: false });
  });
});

describe("words for a Game", () => {
  it("shows the API's problems: its message and each detail", () => {
    const error = new ApiError(422, "validation_failed", "The request is invalid", [
      { path: "bots[0].name", message: "is already used in this Game" },
      { path: "", message: "the Entry costs more than the Point Budget" },
    ]);
    expect(problemText(error)).toBe("The request is invalid bots[0].name is already used in this Game. the Entry costs more than the Point Budget.");
    expect(problemText(new Error("boom"))).toBe("Something went wrong. Try again.");
  });

  it("says who won and how, or that it was a Draw", () => {
    expect(resultText({ tick: 812, end: "last_standing", winner: ada, decidedBy: "survival" })).toBe("ada_bot wins by survival (last standing, Tick 812)");
    expect(resultText({ tick: 1200, end: "time_limit", winner: null, decidedBy: null })).toBe("Draw (time limit, Tick 1200)");
  });

  it("says why a Game was cancelled", () => {
    expect(cancelReasonText({ cancelReason: "initiator", initiator: ada })).toBe("Cancelled by its Initiator, ada_bot.");
    expect(cancelReasonText({ cancelReason: "fill_timeout", initiator: ada })).toContain("not full by its fill deadline");
  });
});

describe("the Game page", () => {
  const services = createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/games/g1") });
  const view = (game: Game, props: Partial<GameViewProps> = {}) =>
    renderToString(
      <ServicesProvider services={services}>
        <GameView game={game} playerId={ada.id} busy={false} onCancel={() => undefined} onWithdraw={() => undefined} onRefresh={() => undefined} {...props} />
      </ServicesProvider>,
    );

  it("shows an Open Game's Entries with their Players and Bot Names, and the actions the Player may take", () => {
    const html = view(testGame({ initiator: bob, entries: [entry("e2", bob, ["Tank", "Scout"])] }));
    expect(html).toContain("bob_bot");
    expect(html).toContain("Tank, Scout");
    expect(html).toContain('href="/play/games/g1/enter"');
    expect(html).not.toContain("Cancel Game");
    expect(html).not.toContain("Withdraw");
  });

  it("offers the Initiator cancelling, and a Player with an Entry withdrawing it", () => {
    const html = view(testGame({ entries: [entry("e1", ada, ["Hunter"], 900)] }));
    expect(html).toContain("Cancel Game");
    expect(html).toContain("Withdraw my Entry");
    expect(html).toContain("ada_bot<!-- --> (you)");
    expect(html).not.toContain("Enter this Game");
  });

  it("shows an action's problem", () => {
    expect(view(testGame(), { problem: "The Game is running, not open" })).toContain('role="alert">The Game is running, not open');
  });

  it("links a Running real-time Game to watching live, and says an unthrottled one has its Replay when Finished", () => {
    expect(view(testGame({ state: "running", startedAt: "2026-10-31T00:10:00.000Z" }))).toContain('href="/play/games/g1/watch"');
    const unthrottled = view(testGame({ state: "running", pace: "unthrottled" }));
    expect(unthrottled).toContain("Replay comes when it is Finished");
    expect(unthrottled).toContain(">Wait for the Replay</a>");
  });

  it("shows a Finished Game's result with a link to its Replay", () => {
    const html = view(testGame({ state: "finished", result: { tick: 812, end: "last_standing", winner: ada, decidedBy: "survival" } }));
    expect(html).toContain("ada_bot wins by survival (last standing, Tick 812)");
    expect(html).toContain("Watch the Replay");
  });

  it("shows why and when a Game was cancelled", () => {
    const html = view(testGame({ state: "cancelled", cancelReason: "fill_timeout", endedAt: "2026-10-31T01:00:00.000Z" }));
    expect(html).toContain("not full by its fill deadline");
    expect(html).toContain("<dt>Cancelled</dt>");
  });
});

describe("the Games screen", () => {
  const session = JSON.stringify({ token: "pts_1", expiresAt: "2099-01-01T00:00:00.000Z", player: { ...ada, createdAt: "" } });
  const render = (url: string) =>
    renderToString(
      <App services={createServices({ fetch: fakeApi().fetch, storage: memoryStorage({ [SESSION_STORAGE_KEY]: session }), history: memoryHistory(url) })} />,
    );

  it("shows the browse filters from the route, and My Games' states", () => {
    expect(render("/play/?players=4")).toContain('value="4"');
    const mine = render("/play/?tab=mine&state=finished");
    expect(mine).toContain("My Games");
    expect(mine).toContain('<input type="checkbox" checked=""/>Finished');
  });

  it("lists Games linking to their pages, with Load more while there are more", () => {
    const html = renderToString(
      <ServicesProvider services={createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/") })}>
        <GameTable pages={{ items: [testGame()], status: "loaded", more: true, loadMore: () => undefined }} empty="none" showState={false} />
      </ServicesProvider>,
    );
    expect(html).toContain('href="/play/games/g1"');
    expect(html).toContain("Crossroads");
    expect(html).toContain("Load more");
  });

  it("routes a Game's paths", () => {
    expect(matchGameRoute("/games/g%201")).toEqual({ id: "g 1" });
    expect(matchGameRoute("/games/g1/enter")).toEqual({ id: "g1", sub: "enter" });
    expect(matchGameRoute("/games/g1/replay")).toBeUndefined();
    expect(matchGameRoute("/games/")).toBeUndefined();
  });
});

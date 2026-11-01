import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { App } from "./app.js";
import {
  designsForRuleset,
  entryFromFields,
  entryProblemFields,
  entryTotal,
  newBotName,
  submitEntry,
  takenBotNames,
  type EntryBotFields,
} from "./entries.js";
import { formProblems } from "./games.js";
import { ServicesProvider } from "./hooks.js";
import { iconPath } from "./images.js";
import { cannotEnter, EnterGameView, type EnterGameViewProps } from "./screens/enter-game.js";
import { createServices, signUp } from "./services.js";
import { SESSION_STORAGE_KEY } from "./session.js";
import { fakeApi, memoryHistory, memoryStorage, testDesign, testGame } from "./test-platform.js";

const hunter = testDesign();
const tank = testDesign({ id: "d2", name: "Tank", cost: 700, latestRevision: { number: 3, cost: 700, notes: "", createdAt: "2026-10-31T00:00:00.000Z" } });
const designs = [hunter, tank];
const bot = (key: number, designId: string, name: string): EntryBotFields => ({ key, designId, name });
const rival = {
  id: "e-rival",
  player: { id: "p-grace", username: "grace", emblem: null },
  createdAt: "2026-10-31T00:05:00.000Z",
  bots: [{ name: "Hunter" }],
};

describe("the Entry being made", () => {
  it("names a new Bot after its design, clear of names already taken in the Game or the Entry, ignoring case", () => {
    expect(newBotName(hunter, [])).toBe("Hunter");
    expect(newBotName(hunter, ["hunter", "Hunter 2"])).toBe("Hunter 3");
    expect(newBotName({ name: "A".repeat(40) }, ["A".repeat(32)])).toBe(`${"A".repeat(30)} 2`);
    expect(takenBotNames(testGame({ entries: [rival] }))).toEqual(["Hunter"]);
  });

  it("totals its Bots at their designs' latest Revisions", () => {
    expect(entryTotal([], designs)).toBe(0);
    expect(entryTotal([bot(1, "d1", "a"), bot(2, "d2", "b"), bot(3, "d1", "c")], designs)).toBe(1500);
  });

  it("makes the Entry to submit, each Bot at the Revision shown and its name trimmed", () => {
    expect(entryFromFields([bot(1, "d1", " Hunter "), bot(2, "d2", "Tank")], designs)).toEqual({
      entry: {
        bots: [
          { designId: "d1", name: "Hunter", revision: 1 },
          { designId: "d2", name: "Tank", revision: 3 },
        ],
      },
    });
  });

  it("stops at no Bots, an empty name or a name used twice, against its field", () => {
    expect(entryFromFields([], designs)).toEqual({ problems: { fields: { bots: "Add at least one Bot." } } });
    expect(entryFromFields([bot(1, "d1", "Hunter"), bot(2, "d1", " "), bot(3, "d2", "HUNTER")], designs)).toEqual({
      problems: { fields: { "bots[1].name": "Give this Bot a name.", "bots[2].name": "Is already used in this Entry." } },
    });
  });

  it("shows the API's problems by the Bot they name, a Revision under its design, and the Point Budget under the total", () => {
    const { fields, aliases } = entryProblemFields(2);
    const error = new ApiError(422, "validation_failed", "The request is invalid", [
      { path: "bots[1].name", message: "is already taken in this Game" },
      { path: "bots[0].revision", message: "is not a Revision of Bot Design d1" },
      { path: "bots", message: "cost 2100 points, more than this Game's Point Budget of 1000" },
    ]);
    expect(formProblems(error, fields, aliases)).toEqual({
      fields: {
        "bots[1].name": "Is already taken in this Game.",
        "bots[0].designId": "Is not a Revision of Bot Design d1.",
        bots: "Cost 2100 points, more than this Game's Point Budget of 1000.",
      },
    });
  });
});

describe("entering a Game through the API", () => {
  async function signedIn(api: ReturnType<typeof fakeApi>) {
    const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history: memoryHistory("/play/games/g1/enter") });
    await signUp(services, { username: "ada_bot", password: "correct horse" }, "/games/g1/enter");
    return services;
  }

  it("lists the Player's Bot Designs for the Game's Ruleset", async () => {
    const api = fakeApi({ designs: [...designs, testDesign({ id: "d3", rulesetVersion: "r2" })] });
    const services = await signedIn(api);
    expect((await designsForRuleset(services.api, "r1")).map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(api.requests.at(-1)).toBe("GET /bot-designs?rulesetVersion=r1&limit=200");
  });

  it("submits the Entry; the one that fills the Game starts it", async () => {
    const api = fakeApi({ games: [testGame({ entries: [rival] })], designs });
    const services = await signedIn(api);
    const submitted = await submitEntry(services.api, "g1", { bots: [{ designId: "d1", name: "Hunter 2", revision: 1 }] });
    expect(api.requests.at(-1)).toBe("POST /games/g1/entries");
    expect(submitted.entry).toMatchObject({ player: { username: "ada_bot" }, cost: 400, bots: [{ name: "Hunter 2" }] });
    expect(submitted.game).toMatchObject({ state: "running", entryCount: 2 });
  });

  it("fails with details against the Bot whose name is taken and against the Entry over its Point Budget", async () => {
    const services = await signedIn(fakeApi({ games: [testGame({ entries: [rival] })], designs }));
    const error = await submitEntry(services.api, "g1", {
      bots: [
        { designId: "d2", name: "Tank" },
        { designId: "d1", name: "hunter" },
      ],
    }).catch((e: unknown) => e);
    const { fields, aliases } = entryProblemFields(2);
    expect(formProblems(error, fields, aliases)).toEqual({
      fields: { "bots[1].name": "Is already taken in this Game.", bots: "Cost 1100 points, more than this Game's Point Budget of 1000." },
    });
  });
});

describe("the Enter Game screen", () => {
  const services = () => createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/games/g1/enter") });
  const render = (props: Partial<EnterGameViewProps> = {}) =>
    renderToString(
      <ServicesProvider services={services()}>
        <EnterGameView
          game={testGame()}
          designs={designs}
          bots={[]}
          problems={{ fields: {} }}
          busy={false}
          onAdd={() => undefined}
          onRemove={() => undefined}
          onRename={() => undefined}
          onSubmit={() => undefined}
          {...props}
        />
      </ServicesProvider>,
    );

  it("lists the Garage's designs at their latest Revision, and a total of nothing yet", () => {
    const html = render();
    expect(html).toContain("<td>Tank</td><td>3</td><td>700</td>");
    expect(html).toContain('aria-label="Add a Hunter Bot"');
    expect(html).toContain("No Bots yet");
    expect(html).toMatch(/Total: <!-- -->0<!-- --> of <!-- -->1000<!-- --> points/);
  });

  it("draws each design's Icon in the picker, and nothing for one with none or one that cannot be fetched", async () => {
    const services = createServices({
      fetch: fakeApi({ icons: { i1: Uint8Array.of(1) } }).fetch,
      storage: memoryStorage(),
      history: memoryHistory("/play/games/g1/enter"),
      decodeImage: () => Promise.resolve({ width: 32, height: 32, close: () => undefined }),
    });
    await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
    await services.images.load(iconPath("i1"));
    await services.images.load(iconPath("gone"));
    const withIcons = [{ ...hunter, icon: "i1" }, { ...tank, icon: "gone" }, testDesign({ id: "d3", name: "Plain" })];
    const html = renderToString(
      <ServicesProvider services={services}>
        <EnterGameView
          game={testGame()}
          designs={withIcons}
          bots={[]}
          problems={{ fields: {} }}
          busy={false}
          onAdd={() => undefined}
          onRemove={() => undefined}
          onRename={() => undefined}
          onSubmit={() => undefined}
        />
      </ServicesProvider>,
    );
    expect(html).toMatch(/<td><canvas role="img" aria-label="Hunter&#x27;s Icon"[^>]*class="icon"><\/canvas>Hunter<\/td>/);
    expect(html).toContain("<td>Tank</td>");
    expect(html).toContain("<td>Plain</td>");
  });

  it("names each Bot in the Entry and keeps the running total, marking it over the Point Budget", () => {
    const html = render({ bots: [bot(1, "d1", "Hunter"), bot(2, "d2", "Tank")] });
    expect(html).toContain('name="bots[0].name" value="Hunter"');
    expect(html).toContain('name="bots[1].name" value="Tank"');
    expect(html).toContain('class="total over"');
    expect(html).toContain("1100<!-- --> of <!-- -->1000<!-- --> points<!-- -->, 100 over the Point Budget");
  });

  it("shows problems by their Bots and the total, and others above the form", () => {
    const html = render({
      bots: [bot(1, "d1", "Hunter")],
      problems: { form: "The Game is running, not open.", fields: { "bots[0].name": "Is already taken in this Game.", bots: "Cost too much." } },
    });
    expect(html).toContain('aria-invalid="true" aria-describedby="bots[0].name-problem" name="bots[0].name" value="Hunter"');
    expect(html).toContain('class="total invalid"');
    expect(html).toContain('<p class="error" id="bots[0].name-problem">Is already taken in this Game.</p>');
    expect(html).toContain('<p class="error" id="bots-problem">Cost too much.</p>');
    expect(html).toContain('role="alert">The Game is running, not open.');
  });

  it("says when the Garage has nothing for the Game's Ruleset", () => {
    expect(render({ designs: [] })).toContain("You have no Bot Designs for Ruleset");
  });

  it("explains why a Game cannot be entered", () => {
    expect(cannotEnter(testGame(), "p-ada_bot")).toBeUndefined();
    expect(cannotEnter(testGame({ state: "running" }), "p-ada_bot")).toBe("This Game is Running, so it takes no more Entries.");
    expect(cannotEnter(testGame({ entries: [{ ...rival, player: { id: "p-ada_bot", username: "ada_bot", emblem: null } }] }), "p-ada_bot")).toBe(
      "You have already entered this Game.",
    );
    expect(cannotEnter(testGame({ playerCount: 1, entries: [rival] }), "p-ada_bot")).toBe("This Game is full.");
  });

  it("is routed at /games/{id}/enter", () => {
    const storage = memoryStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({ token: "pts_1", expiresAt: "2099-01-01T00:00:00.000Z", player: { id: "p-ada", username: "ada_bot", createdAt: "2026-10-31T00:00:00.000Z" } }),
    });
    const html = renderToString(<App services={createServices({ fetch: fakeApi().fetch, storage, history: memoryHistory("/play/games/g1/enter") })} />);
    expect(html).toContain("Loading…");
    expect(html).not.toContain("not in the web client yet");
  });
});

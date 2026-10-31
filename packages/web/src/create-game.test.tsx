import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { App } from "./app.js";
import { createGame, formProblems, newGameFields, newGameFromFields, playableMaps, type NewGameField, type NewGameFields } from "./games.js";
import { ServicesProvider } from "./hooks.js";
import { CreateGameView, type CreateGameViewProps } from "./screens/create-game.js";
import { createServices, signUp } from "./services.js";
import { SESSION_STORAGE_KEY } from "./session.js";
import { fakeApi, mapSummary, memoryHistory, memoryStorage, TEST_RULESETS, testMap } from "./test-platform.js";

const duel = testMap();
const crossroads = testMap({ id: "m2", name: "Crossroads" });
const fourFormat = mapSummary(testMap({ id: "m3", name: "Future" }));
const future = { ...fourFormat, latestRevision: { ...fourFormat.latestRevision, format: 2 } };
const summaries = [mapSummary(duel), mapSummary(crossroads), future];
const r2 = { version: "r2", tickRate: 20, pointBudget: { min: 200, max: 3000 }, mapFormats: [1, 2] };

const fields = (changes: Partial<NewGameFields> = {}): NewGameFields => ({ ...newGameFields(TEST_RULESETS, summaries), ...changes });

describe("the Create Game form's values", () => {
  it("starts from the newest Ruleset, its largest Point Budget, its first playable Map and the CLI's defaults", () => {
    expect(newGameFields([...TEST_RULESETS, r2], [future, ...summaries])).toEqual({
      rulesetVersion: "r2",
      mapId: "m3",
      playerCount: "2",
      pointBudget: "3000",
      timeLimitSeconds: "120",
      pace: "realtime",
      fillTimeoutSeconds: "3600",
    });
    expect(newGameFields(TEST_RULESETS, [future, ...summaries]).mapId).toBe("m1");
  });

  it("offers only the Maps in a Map Format the Ruleset supports", () => {
    expect(playableMaps(summaries, TEST_RULESETS[0]).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(playableMaps(summaries, r2).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(playableMaps(summaries, undefined)).toEqual([]);
  });

  it("makes the Game to create, with numbers as numbers", () => {
    expect(newGameFromFields(fields({ playerCount: " 2 ", pace: "unthrottled" }))).toEqual({
      game: { rulesetVersion: "r1", mapId: "m1", playerCount: 2, pointBudget: 2000, timeLimitSeconds: 120, pace: "unthrottled", fillTimeoutSeconds: 3600 },
    });
  });

  it("stops at a missing Map or a number that is not whole, against its field", () => {
    expect(newGameFromFields(fields({ mapId: "", pointBudget: "lots", timeLimitSeconds: "1.5" }))).toEqual({
      problems: { fields: { mapId: "Choose a Map.", pointBudget: "Must be a whole number.", timeLimitSeconds: "Must be a whole number." } },
    });
  });
});

describe("the API's problems against fields", () => {
  const fieldNames: readonly NewGameField[] = ["mapId", "playerCount", "pointBudget"];
  const invalid = (details: { path: string; message: string }[]) => new ApiError(422, "validation_failed", "The request is invalid", details);

  it("shows each detail by the field it names, joining several for one field", () => {
    const error = invalid([
      { path: "playerCount", message: "must be an integer from 2 to 2" },
      { path: "mapRevision", message: "is not a Revision of Map m1" },
      { path: "mapId", message: "is an archived Map" },
    ]);
    expect(formProblems(error, fieldNames, { mapRevision: "mapId" })).toEqual({
      fields: { playerCount: "Must be an integer from 2 to 2.", mapId: "Is not a Revision of Map m1. Is an archived Map." },
    });
  });

  it("shows details for no field, and failures without details, above the form", () => {
    expect(formProblems(invalid([{ path: "(body)", message: "must be a JSON object" }]), fieldNames)).toEqual({
      form: "The request is invalid (body) must be a JSON object.",
      fields: {},
    });
    expect(formProblems(new ApiError(0, "network", "Cannot reach the server."), fieldNames)).toEqual({ form: "Cannot reach the server.", fields: {} });
  });
});

describe("creating a Game through the API", () => {
  async function signedIn(api: ReturnType<typeof fakeApi>) {
    const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history: memoryHistory("/play/games/new") });
    await signUp(services, { username: "ada_bot", password: "correct horse" }, "/games/new");
    return services;
  }

  it("creates an Open Game initiated by the Player", async () => {
    const api = fakeApi({ maps: [duel] });
    const services = await signedIn(api);
    const created = newGameFromFields(fields());
    if (!("game" in created)) throw new Error("expected a Game");
    const game = await createGame(services.api, created.game);
    expect(api.requests.at(-1)).toBe("POST /games");
    expect(game).toMatchObject({ state: "open", initiator: { username: "ada_bot" }, map: { id: "m1", name: "Duel" }, pointBudget: 2000 });
  });

  it("fails with the API's details when the Map has too few Spawn Zones", async () => {
    const services = await signedIn(fakeApi({ maps: [duel] }));
    const created = newGameFromFields(fields({ playerCount: "3" }));
    if (!("game" in created)) throw new Error("expected a Game");
    const error = await createGame(services.api, created.game).catch((e: unknown) => e);
    expect(formProblems(error, ["playerCount"]).fields.playerCount).toBe("Must be an integer from 2 to 2.");
  });
});

describe("the Create Game screen", () => {
  const services = () => createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/games/new") });
  const render = (props: Partial<CreateGameViewProps> = {}) =>
    renderToString(
      <ServicesProvider services={services()}>
        <CreateGameView
          rulesets={TEST_RULESETS}
          maps={summaries}
          values={fields()}
          problems={{ fields: {} }}
          busy={false}
          onChange={() => undefined}
          onSubmit={() => undefined}
          {...props}
        />
      </ServicesProvider>,
    );

  it("offers the Ruleset's playable Maps with their Player counts, and the Point Budget range", () => {
    const html = render();
    expect(html).toContain("Duel (up to 2 Players)");
    expect(html).toContain("Crossroads");
    expect(html).not.toContain("Future");
    expect(html).toContain("100<!-- --> to <!-- -->2000<!-- --> in <!-- -->r1");
    expect(html).toContain("Create Game");
  });

  it("previews the chosen Map with its description", () => {
    const html = render({ preview: duel.latestRevision.map as never, mapDescription: "Two Players, face to face." });
    expect(html).toContain('aria-label="Duel preview"');
    expect(html).toContain("Two Players, face to face.");
  });

  it("shows problems by their fields, and others above the form", () => {
    const html = render({ problems: { form: "The server is busy.", fields: { playerCount: "Must be an integer from 2 to 2." } } });
    expect(html).toMatch(/aria-invalid="true" aria-describedby="playerCount-problem"/);
    expect(html).toContain('<p class="error" id="playerCount-problem">Must be an integer from 2 to 2.</p>');
    expect(html).toContain('role="alert">The server is busy.');
  });

  it("is routed at /games/new, not taken for a Game, and linked from the shell", () => {
    const storage = memoryStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({ token: "pts_1", expiresAt: "2099-01-01T00:00:00.000Z", player: { id: "p-ada", username: "ada_bot", createdAt: "2026-10-31T00:00:00.000Z" } }),
    });
    const html = renderToString(<App services={createServices({ fetch: fakeApi().fetch, storage, history: memoryHistory("/play/games/new") })} />);
    expect(html).toContain("<h2>Create Game</h2>");
    expect(html).toContain('href="/play/games/new"');
  });
});

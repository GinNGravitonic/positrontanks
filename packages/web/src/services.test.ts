import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { safeNext } from "./router.js";
import { createServices, logIn, logOut, signUp } from "./services.js";
import { SESSION_STORAGE_KEY } from "./session.js";
import { fakeApi, memoryHistory, memoryStorage, testGame } from "./test-platform.js";

const ada = { username: "ada_bot", password: "correct horse" };

function setup(start: string) {
  const api = fakeApi({ games: [testGame({ id: "7" }), testGame({ id: "42" })] });
  const history = memoryHistory(start);
  const storage = memoryStorage();
  const services = createServices({ fetch: api.fetch, storage, history });
  const at = () => history.location.pathname + history.location.search;
  return { api, history, storage, services, at };
}

describe("signing in", () => {
  it("signs up, logs in as the new Player and keeps the session in localStorage", async () => {
    const { api, storage, services, at } = setup("/play/signup");
    await signUp(services, ada, null);
    expect(api.requests).toEqual(["POST /players", "POST /sessions"]);
    expect(services.session.current()?.player.username).toBe("ada_bot");
    expect(storage.items.get(SESSION_STORAGE_KEY)).toContain('"token":"pts_1"');
    expect(at()).toBe("/play/");
  });

  it("logs in with the stored session's token on later requests, and in a new page", async () => {
    const { api, storage, services, history } = setup("/play/signup");
    await signUp(services, ada, null);
    await services.api.request("GET", "/games/7");
    const reloaded = createServices({ fetch: api.fetch, storage, history });
    expect(reloaded.session.token()).toBe("pts_1");
    await expect(reloaded.api.request("GET", "/games/7")).resolves.toMatchObject({ id: "7" });
  });

  it("logs out: ends the session on the server, forgets it, and goes to log-in", async () => {
    const { api, storage, services, at } = setup("/play/signup");
    await signUp(services, ada, null);
    await logOut(services);
    expect(api.requests.at(-1)).toBe("DELETE /sessions/current");
    expect(services.session.current()).toBeUndefined();
    expect(storage.items.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(at()).toBe("/play/login");
  });

  it("shows a wrong password as an error, without leaving log-in", async () => {
    const { services, at } = setup("/play/signup");
    await signUp(services, ada, null);
    await logOut(services);
    const failed = logIn(services, { ...ada, password: "wrong password" }, null);
    await expect(failed).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(at()).toBe("/play/login");
  });

  it("returns a sign-up's validation problems", async () => {
    const { services } = setup("/play/signup");
    const failed = signUp(services, { username: "ada_bot", password: "short" }, null);
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({ details: [{ path: "password", message: "must be 8 to 256 characters" }] });
  });
});

describe("an expired session", () => {
  it("goes to log-in on a 401, then back to the page the Player was on", async () => {
    const { api, services, history, at } = setup("/play/signup");
    await signUp(services, ada, null);
    services.router.navigate("/games/42?tab=entries");

    api.expireSessions();
    await expect(services.api.request("GET", "/games/42")).rejects.toMatchObject({ status: 401 });
    expect(services.session.current()).toBeUndefined();
    expect(at()).toBe("/play/login?next=%2Fgames%2F42%3Ftab%3Dentries");

    await logIn(services, ada, services.router.current().search.get("next"));
    expect(at()).toBe("/play/games/42?tab=entries");
    // Log-in replaced itself in history, so Back does not return to it.
    expect(history.entries).toEqual(["/play/", "/play/games/42?tab=entries"]);
  });

  it("drops a stored session past its expiry", () => {
    const stored = JSON.stringify({ token: "pts_old", expiresAt: "2020-01-01T00:00:00.000Z", player: { id: "p", username: "ada_bot", createdAt: "" } });
    const services = createServices({ fetch: fakeApi().fetch, storage: memoryStorage({ [SESSION_STORAGE_KEY]: stored }), history: memoryHistory("/play/") });
    expect(services.session.current()).toBeUndefined();
  });
});

describe("safeNext", () => {
  it("keeps paths inside the client and refuses anything else", () => {
    expect(safeNext("/games/42?tab=entries")).toBe("/games/42?tab=entries");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example/")).toBe("/");
  });
});

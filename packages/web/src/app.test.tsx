import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { App, redirectFor } from "./app.js";
import { Router } from "./router.js";
import { formErrors } from "./screens/credentials-form.js";
import { createServices } from "./services.js";
import { SESSION_STORAGE_KEY } from "./session.js";
import { fakeApi, memoryHistory, memoryStorage } from "./test-platform.js";

const session = JSON.stringify({
  token: "pts_1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  player: { id: "p-ada", username: "ada_bot", createdAt: "2026-10-31T00:00:00.000Z" },
});

function render(url: string, signedIn: boolean): string {
  const storage = memoryStorage(signedIn ? { [SESSION_STORAGE_KEY]: session } : {});
  return renderToString(<App services={createServices({ fetch: fakeApi().fetch, storage, history: memoryHistory(url) })} />);
}

const route = (url: string) => new Router(memoryHistory(url)).current();

describe("App", () => {
  it("shows log-in and sign-up to a signed-out visitor", () => {
    expect(render("/play/login", false)).toContain("Log in");
    expect(render("/play/signup?next=%2Fgames", false)).toContain('href="/play/login?next=%2Fgames"');
  });

  it("shows the shell with the Player and a log-out button when signed in", () => {
    const html = render("/play/", true);
    expect(html).toContain("ada_bot");
    expect(html).toContain("Log out");
  });

  it("sends a signed-out visitor to log-in from every other route, and back afterwards", () => {
    expect(render("/play/", false)).toBe("");
    expect(redirectFor(route("/play/"), false)).toBe("/login");
    expect(redirectFor(route("/play/games/42?tab=entries"), false)).toBe("/login?next=%2Fgames%2F42%3Ftab%3Dentries");
    expect(redirectFor(route("/play/login"), false)).toBeUndefined();
  });

  it("sends a signed-in Player away from log-in and sign-up, to their next page", () => {
    expect(redirectFor(route("/play/login?next=%2Fgames%2F42"), true)).toBe("/games/42");
    expect(redirectFor(route("/play/signup"), true)).toBe("/");
    expect(redirectFor(route("/play/games/42"), true)).toBeUndefined();
  });
});

describe("formErrors", () => {
  it("puts the API's problems against the fields they name", () => {
    const error = new ApiError(422, "validation_failed", "The request is invalid", [
      { path: "username", message: "must be 3 to 32 letters, digits, '-' or '_'" },
      { path: "password", message: "must be 8 to 256 characters" },
    ]);
    expect(formErrors(error)).toEqual({
      username: "Username must be 3 to 32 letters, digits, '-' or '_'.",
      password: "Password must be 8 to 256 characters.",
    });
  });

  it("shows a taken username by the username, and other failures above the form", () => {
    expect(formErrors(new ApiError(409, "username_taken", 'The username "ada" is already taken'))).toEqual({
      username: 'The username "ada" is already taken',
    });
    expect(formErrors(new ApiError(401, "invalid_credentials", "The username or password is incorrect"))).toEqual({
      form: "The username or password is incorrect",
    });
  });
});

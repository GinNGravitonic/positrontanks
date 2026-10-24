import { describe, expect, it } from "vitest";
import { ApiError } from "./errors.js";
import { Router, type Method, type Route } from "./router.js";

function route(method: Method, path: string, operationId = `${method} ${path}`): Route {
  return { method, path, operation: { operationId, summary: "", responses: {} }, handler: () => ({}) };
}

describe("Router", () => {
  const router = new Router([
    route("GET", "/games"),
    route("GET", "/games/{gameId}"),
    route("DELETE", "/games/{gameId}"),
    route("POST", "/games/{gameId}/entries"),
  ]);

  it("matches literal and parameter segments", () => {
    expect(router.match("GET", "/games")).toMatchObject({ kind: "found", params: {} });
    expect(router.match("GET", "/games/g%2F1")).toMatchObject({ kind: "found", params: { gameId: "g/1" } });
    expect(router.match("POST", "/games/7/entries")).toMatchObject({ kind: "found", params: { gameId: "7" } });
  });

  it("distinguishes a wrong method from a missing path", () => {
    expect(router.match("PUT", "/games/7")).toEqual({ kind: "wrong-method", allowed: ["GET", "DELETE"] });
    expect(router.match("GET", "/games/7/other")).toEqual({ kind: "none" });
    expect(router.match("GET", "/games//entries")).toEqual({ kind: "none" });
  });

  it("rejects malformed parameters as bad requests", () => {
    expect(() => router.match("GET", "/games/%E0")).toThrow(ApiError);
  });

  it("rejects ambiguous or duplicate routes", () => {
    expect(() => new Router([route("GET", "/a/{x}"), route("GET", "/a/{y}")])).toThrow(/Duplicate route/);
    expect(() => new Router([route("GET", "/a", "same"), route("POST", "/a", "same")])).toThrow(/operationId/);
    expect(() => new Router([route("GET", "/a/{x")])).toThrow(/Bad path segment/);
  });
});

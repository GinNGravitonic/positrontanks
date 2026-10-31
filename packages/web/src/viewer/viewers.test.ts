import { defaultRulesetCatalog } from "@positrontanks/server";
import { describe, expect, it } from "vitest";
import { missingViewers, unsupportedText, viewerFor } from "./viewers.js";

describe("the engine viewer registry", () => {
  // Frontend spec section 3: a new Ruleset cannot ship until it can be watched.
  it("has a viewer for every Ruleset the server hosts", () => {
    const hosted = defaultRulesetCatalog().versions();
    expect(hosted.length).toBeGreaterThan(0);
    expect(missingViewers(hosted)).toEqual([]);
  });

  it("names a hosted Ruleset that has no viewer", () => {
    expect(missingViewers(["r1", "r9"])).toEqual(["r9"]);
  });

  it("has no viewer for a Ruleset it does not know, which its Games say", () => {
    expect(viewerFor("r9")).toBeUndefined();
    expect(viewerFor("constructor")).toBeUndefined();
    expect(unsupportedText("r9")).toBe("Ruleset r9 is no longer supported.");
  });
});

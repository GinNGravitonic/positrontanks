import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./app.js";

describe("App", () => {
  it("renders the title", () => {
    expect(renderToString(<App />)).toContain("Positron Tanks");
  });
});

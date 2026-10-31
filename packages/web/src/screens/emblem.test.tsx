import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENTRY_COLORS } from "../draw/colors.js";
import { Emblem, initials, textColorOn } from "./emblem.js";

describe("placeholder Emblems", () => {
  it("show up to two initials of the username", () => {
    expect(initials("ada")).toBe("A");
    expect(initials("ada_bot")).toBe("AB");
    expect(initials("adaLovelace")).toBe("AL");
    expect(initials("grace-brewster-hopper")).toBe("GB");
    expect(initials("x9")).toBe("X");
    expect(initials("élodie")).toBe("É");
  });

  it("pick dark text on light Entry colors and light text on dark ones", () => {
    expect(textColorOn("#fdd835")).toBe("#000000");
    expect(textColorOn("#1e88e5")).toBe("#000000");
    expect(textColorOn("#8e24aa")).toBe("#ffffff");
    expect(ENTRY_COLORS.every((c) => ["#000000", "#ffffff"].includes(textColorOn(c)))).toBe(true);
  });

  it("draw the initials on a disc in the Entry's color", () => {
    const html = renderToString(<Emblem username="ada_bot" color="#e53935" />);
    expect(html).toContain('fill="#e53935"');
    expect(html).toContain(">AB</text>");
    expect(html).toContain("ada_bot&#x27;s Emblem");
  });
});

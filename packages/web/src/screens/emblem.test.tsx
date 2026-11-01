import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENTRY_COLORS } from "../draw/colors.js";
import { ServicesProvider } from "../hooks.js";
import { createServices, signUp, type Services } from "../services.js";
import { emblemPath } from "../images.js";
import { fakeApi, memoryHistory, memoryStorage } from "../test-platform.js";
import { Emblem, initials, textColorOn, type EmblemOwner } from "./emblem.js";

const ada: EmblemOwner = { id: "p-ada_bot", username: "ada_bot", emblem: null };

async function signedIn(emblems: Readonly<Record<string, Uint8Array<ArrayBuffer>>> = {}) {
  const services = createServices({
    fetch: fakeApi({ emblems }).fetch,
    storage: memoryStorage(),
    history: memoryHistory("/play/"),
    decodeImage: () => Promise.resolve({ width: 32, height: 32, close: () => undefined }),
  });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
  return services;
}

function render(services: Services, player: EmblemOwner) {
  return renderToString(
    <ServicesProvider services={services}>
      <Emblem player={player} color="#e53935" />
    </ServicesProvider>,
  );
}

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

  it("draw the initials on a disc in the Entry's color for a Player with no Emblem", async () => {
    const html = render(await signedIn(), ada);
    expect(html).toContain('fill="#e53935"');
    expect(html).toContain(">AB</text>");
    expect(html).toContain("ada_bot&#x27;s Emblem");
  });

  it("stand in while a Player's Emblem is loading", async () => {
    const html = render(await signedIn({ "p-ada_bot/h1": Uint8Array.of(1) }), { ...ada, emblem: "h1" });
    expect(html).toContain(">AB</text>");
  });

  it("stand in for an Emblem that cannot be fetched, such as one taken down", async () => {
    const services = await signedIn();
    await services.images.load(emblemPath("p-ada_bot", "gone"));
    const html = render(services, { ...ada, emblem: "gone" });
    expect(html).toContain(">AB</text>");
  });
});

describe("real Emblems", () => {
  it("are drawn in place of the placeholder once loaded", async () => {
    const services = await signedIn({ "p-ada_bot/h1": Uint8Array.of(1) });
    await services.images.load(emblemPath("p-ada_bot", "h1"));
    const html = render(services, { ...ada, emblem: "h1" });
    expect(html).toMatch(/^<canvas role="img" aria-label="ada_bot&#x27;s Emblem" style="width:32px;height:32px" class="emblem">/);
    expect(html).not.toContain("<text");
  });
});

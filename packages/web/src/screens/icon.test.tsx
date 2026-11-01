import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../hooks.js";
import { iconPath } from "../images.js";
import { createServices, signUp, type Services } from "../services.js";
import { fakeApi, memoryHistory, memoryStorage } from "../test-platform.js";
import { Icon } from "./icon.js";

async function signedIn(icons: Readonly<Record<string, Uint8Array<ArrayBuffer>>> = {}) {
  const services = createServices({
    fetch: fakeApi({ icons }).fetch,
    storage: memoryStorage(),
    history: memoryHistory("/play/"),
    decodeImage: () => Promise.resolve({ width: 32, height: 32, close: () => undefined }),
  });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
  return services;
}

function render(services: Services, icon: string | null | undefined) {
  return renderToString(
    <ServicesProvider services={services}>
      <Icon icon={icon} name="Hunter" />
    </ServicesProvider>,
  );
}

describe("Icons", () => {
  it("are drawn once loaded", async () => {
    const services = await signedIn({ i1: Uint8Array.of(1) });
    await services.images.load(iconPath("i1"));
    expect(render(services, "i1")).toBe(
      '<canvas role="img" aria-label="Hunter&#x27;s Icon" style="width:24px;height:24px" class="icon"></canvas>',
    );
  });

  it("draw nothing for a design with no Icon", async () => {
    const services = await signedIn();
    expect(render(services, null)).toBe("");
    expect(render(services, undefined)).toBe("");
  });

  it("draw nothing while loading", async () => {
    expect(render(await signedIn({ i1: Uint8Array.of(1) }), "i1")).toBe("");
  });

  it("draw nothing, and no placeholder, for an Icon that cannot be fetched, such as one taken down", async () => {
    const services = await signedIn();
    expect(await services.images.load(iconPath("gone"))).toBeNull();
    expect(render(services, "gone")).toBe("");
  });
});

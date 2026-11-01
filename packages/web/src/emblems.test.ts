import { describe, expect, it } from "vitest";
import { createServices, signUp } from "./services.js";
import { fakeApi, memoryHistory, memoryStorage } from "./test-platform.js";

/** Stands in for a PNG: the fake decoder only reads its first byte. */
const IMAGE = Uint8Array.of(7, 1, 2, 3);

/** Decodes an image to a stand-in ImageBitmap whose width is the image's first byte; fails on an empty image. */
async function decode(image: Blob): Promise<ImageBitmap> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  const width = bytes[0];
  if (width === undefined) throw new Error("not an image");
  return { width, height: width, close: () => undefined };
}

async function signedIn(fetch: typeof globalThis.fetch, decodeImage = decode) {
  const services = createServices({ fetch, storage: memoryStorage(), history: memoryHistory("/play/"), decodeImage });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
  return services;
}

describe("the Emblem cache", () => {
  it("fetches an Emblem with the session token and decodes it", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    let authorization: string | null = null;
    const { emblems } = await signedIn((input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return api.fetch(input, init);
    });
    expect(emblems.get("p-grace", "h1")).toBeUndefined();
    const image = await emblems.load("p-grace", "h1");
    expect(image?.width).toBe(7);
    expect(emblems.get("p-grace", "h1")).toBe(image);
    expect(api.requests).toContain("GET /players/p-grace/emblem/h1");
    expect(authorization).toMatch(/^Bearer pts_/);
  });

  it("asks for each Player's Emblem with a given hash once", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE, "p-grace/h2": IMAGE, "p-alan/h1": IMAGE } });
    const { emblems } = await signedIn(api.fetch);
    const [a, b] = await Promise.all([emblems.load("p-grace", "h1"), emblems.load("p-grace", "h1")]);
    expect(a).toBe(b);
    await emblems.load("p-grace", "h1");
    await emblems.load("p-grace", "h2");
    await emblems.load("p-alan", "h1");
    const asked = (path: string) => api.requests.filter((r) => r === `GET ${path}`).length;
    expect(asked("/players/p-grace/emblem/h1")).toBe(1);
    expect(asked("/players/p-grace/emblem/h2")).toBe(1);
    expect(asked("/players/p-alan/emblem/h1")).toBe(1);
  });

  it("keeps an Emblem that is not there, such as one taken down, as nothing to draw", async () => {
    const api = fakeApi();
    const { emblems } = await signedIn(api.fetch);
    expect(await emblems.load("p-grace", "gone")).toBeNull();
    expect(emblems.get("p-grace", "gone")).toBeNull();
    await emblems.load("p-grace", "gone");
    expect(api.requests.filter((r) => r === "GET /players/p-grace/emblem/gone")).toHaveLength(1);
  });

  it("keeps an Emblem that cannot be decoded as nothing to draw", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": new Uint8Array() } });
    const { emblems } = await signedIn(api.fetch);
    expect(await emblems.load("p-grace", "h1")).toBeNull();
    expect(emblems.get("p-grace", "h1")).toBeNull();
  });

  it("asks again after the server could not be reached", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    let reachable = false;
    const { emblems } = await signedIn((input, init) => {
      const path = typeof input === "string" ? input : "";
      return reachable || !path.includes("/emblem/") ? api.fetch(input, init) : Promise.reject(new TypeError("Failed to fetch"));
    });
    expect(await emblems.load("p-grace", "h1")).toBeNull();
    expect(emblems.get("p-grace", "h1")).toBeUndefined();
    reachable = true;
    expect((await emblems.load("p-grace", "h1"))?.width).toBe(7);
  });

  it("tells subscribers when an Emblem has loaded", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    const { emblems } = await signedIn(api.fetch);
    let told = 0;
    const unsubscribe = emblems.subscribe(() => {
      told++;
    });
    await emblems.load("p-grace", "h1");
    expect(told).toBe(1);
    unsubscribe();
    await emblems.load("p-grace", "h2");
    expect(told).toBe(1);
  });
});

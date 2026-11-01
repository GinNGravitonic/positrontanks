import { describe, expect, it } from "vitest";
import { emblemPath, iconPath } from "./images.js";
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

const asked = (requests: readonly string[], path: string) => requests.filter((r) => r === `GET ${path}`).length;

describe("the image cache", () => {
  it("fetches an Emblem with the session token and decodes it", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    let authorization: string | null = null;
    const { images } = await signedIn((input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return api.fetch(input, init);
    });
    const path = emblemPath("p-grace", "h1");
    expect(images.get(path)).toBeUndefined();
    const image = await images.load(path);
    expect(image?.width).toBe(7);
    expect(images.get(path)).toBe(image);
    expect(api.requests).toContain("GET /players/p-grace/emblem/h1");
    expect(authorization).toMatch(/^Bearer pts_/);
  });

  it("fetches an Icon from /icons/{hash} with the session token and decodes it", async () => {
    const api = fakeApi({ icons: { i1: IMAGE } });
    let authorization: string | null = null;
    const { images } = await signedIn((input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return api.fetch(input, init);
    });
    const image = await images.load(iconPath("i1"));
    expect(image?.width).toBe(7);
    expect(images.get(iconPath("i1"))).toBe(image);
    expect(api.requests).toContain("GET /icons/i1");
    expect(authorization).toMatch(/^Bearer pts_/);
  });

  it("asks for each image once", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE, "p-grace/h2": IMAGE, "p-alan/h1": IMAGE }, icons: { h1: IMAGE } });
    const { images } = await signedIn(api.fetch);
    const [a, b] = await Promise.all([images.load(emblemPath("p-grace", "h1")), images.load(emblemPath("p-grace", "h1"))]);
    expect(a).toBe(b);
    await images.load(emblemPath("p-grace", "h1"));
    await images.load(emblemPath("p-grace", "h2"));
    await images.load(emblemPath("p-alan", "h1"));
    await Promise.all([images.load(iconPath("h1")), images.load(iconPath("h1"))]);
    await images.load(iconPath("h1"));
    expect(asked(api.requests, "/players/p-grace/emblem/h1")).toBe(1);
    expect(asked(api.requests, "/players/p-grace/emblem/h2")).toBe(1);
    expect(asked(api.requests, "/players/p-alan/emblem/h1")).toBe(1);
    expect(asked(api.requests, "/icons/h1")).toBe(1);
  });

  it("keeps an image that is not there, such as one taken down, as nothing to draw", async () => {
    const api = fakeApi();
    const { images } = await signedIn(api.fetch);
    for (const path of [emblemPath("p-grace", "gone"), iconPath("gone")]) {
      expect(await images.load(path)).toBeNull();
      expect(images.get(path)).toBeNull();
      await images.load(path);
      expect(asked(api.requests, path)).toBe(1);
    }
  });

  it("keeps an image that cannot be decoded as nothing to draw", async () => {
    const api = fakeApi({ icons: { i1: new Uint8Array() } });
    const { images } = await signedIn(api.fetch);
    expect(await images.load(iconPath("i1"))).toBeNull();
    expect(images.get(iconPath("i1"))).toBeNull();
  });

  it("asks again after the server could not be reached", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    let reachable = false;
    const { images } = await signedIn((input, init) => {
      const path = typeof input === "string" ? input : "";
      return reachable || !path.includes("/emblem/") ? api.fetch(input, init) : Promise.reject(new TypeError("Failed to fetch"));
    });
    const path = emblemPath("p-grace", "h1");
    expect(await images.load(path)).toBeNull();
    expect(images.get(path)).toBeUndefined();
    reachable = true;
    expect((await images.load(path))?.width).toBe(7);
  });

  it("tells subscribers when an image has loaded", async () => {
    const api = fakeApi({ emblems: { "p-grace/h1": IMAGE } });
    const { images } = await signedIn(api.fetch);
    let told = 0;
    const unsubscribe = images.subscribe(() => {
      told++;
    });
    await images.load(emblemPath("p-grace", "h1"));
    expect(told).toBe(1);
    unsubscribe();
    await images.load(emblemPath("p-grace", "h2"));
    expect(told).toBe(1);
  });
});

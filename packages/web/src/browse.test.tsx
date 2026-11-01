import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import r1Json from "@positrontanks/ruleset-data/rulesets/r1.json";
import duelJson from "@positrontanks/ruleset-data/maps/duel.json";
import type { MapFormat1 } from "@positrontanks/ruleset-data";
import { ApiError } from "./api/client.js";
import { App } from "./app.js";
import {
  bareChassisParts,
  buildParts,
  buildRows,
  cachedPartsCatalog,
  componentsByKind,
  designRoute,
  garageFiltersFromSearch,
  getDesign,
  getMapAt,
  kindText,
  listDesignRevisions,
  listDesigns,
  listMapRevisions,
  listMaps,
  mapRoute,
  matchItemRoute,
  partsRoute,
  revisionFromSearch,
  searchFromGarageFilters,
  statText,
} from "./browse.js";
import { ServicesProvider } from "./hooks.js";
import type { PartsCatalog } from "./replays.js";
import { DesignView } from "./screens/garage.js";
import { MapView, obstaclesText, terrainText } from "./screens/maps.js";
import { CatalogView } from "./screens/parts.js";
import { createServices, signUp } from "./services.js";
import { fakeApi, memoryHistory, memoryStorage, testDesign, testDesignRevision, testMap, TEST_BUILD } from "./test-platform.js";

const catalog = r1Json as unknown as PartsCatalog;

async function signedIn(api: ReturnType<typeof fakeApi>, start = "/play/") {
  const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history: memoryHistory(start) });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, start.slice("/play".length));
  return services;
}

describe("browser routes", () => {
  it("name a Bot Design or Map below their list, encoded, at a Revision if asked", () => {
    expect(designRoute("d 1")).toBe("/garage/d%201");
    expect(designRoute("d1", 2)).toBe("/garage/d1?revision=2");
    expect(mapRoute("m1", 3)).toBe("/maps/m1?revision=3");
    expect(partsRoute("r1")).toBe("/parts?ruleset=r1");
    expect(matchItemRoute("/garage", "/garage/d%201")).toBe("d 1");
    expect(matchItemRoute("/garage", "/garage")).toBeUndefined();
    expect(matchItemRoute("/garage", "/garage/")).toBeUndefined();
    expect(matchItemRoute("/maps", "/maps/m1/extra")).toBeUndefined();
    expect(matchItemRoute("/maps", "/maps/%E0")).toBeUndefined();
  });

  it("read a Revision only as a whole number from 1", () => {
    expect(revisionFromSearch(new URLSearchParams("revision=2"))).toBe(2);
    for (const text of ["0", "-1", "1.5", "two", ""]) expect(revisionFromSearch(new URLSearchParams({ revision: text }))).toBeUndefined();
  });

  it("keep the Garage's filters in the query", () => {
    const filters = garageFiltersFromSearch(new URLSearchParams("ruleset=r1&archived=1"));
    expect(filters).toEqual({ rulesetVersion: "r1", includeArchived: true });
    expect(searchFromGarageFilters(filters).toString()).toBe("ruleset=r1&archived=1");
    expect(garageFiltersFromSearch(new URLSearchParams("ruleset=&archived=yes"))).toEqual({ includeArchived: false });
  });
});

describe("loading through the API", () => {
  const designs = [testDesign({ latestRevision: { number: 3, cost: 400, notes: "Faster gun", createdAt: "2026-10-31T00:00:00.000Z" } })];

  it("lists the Player's Bot Designs with the Garage's filters", async () => {
    const api = fakeApi({ designs });
    const services = await signedIn(api);
    expect((await listDesigns(services.api, { rulesetVersion: "r1", includeArchived: true })).botDesigns.map((d) => d.id)).toEqual(["d1"]);
    expect(api.requests.at(-1)).toBe("GET /bot-designs?rulesetVersion=r1&includeArchived=true&limit=25");
    await listDesigns(services.api, { includeArchived: false }, "25");
    expect(api.requests.at(-1)).toBe("GET /bot-designs?limit=25&cursor=25");
  });

  it("loads a Bot Design at its latest Revision with one request, and an earlier one with a second", async () => {
    const api = fakeApi({ designs });
    const services = await signedIn(api);
    const latest = await getDesign(services.api, "d1");
    expect(latest.revision).toMatchObject({ number: 3, notes: "Faster gun", build: TEST_BUILD });
    expect(api.requests.at(-1)).toBe("GET /bot-designs/d1");
    expect((await getDesign(services.api, "d1", 3)).revision.number).toBe(3);
    expect(api.requests.at(-1)).toBe("GET /bot-designs/d1");
    const earlier = await getDesign(services.api, "d1", 1);
    expect(earlier.revision).toMatchObject({ number: 1, notes: "Revision 1", cost: 380 });
    expect(earlier.design.latestRevision.number).toBe(3);
    expect(api.requests.at(-1)).toBe("GET /bot-designs/d1/revisions/1");
    const missing = await getDesign(services.api, "d1", 9).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
  });

  it("lists a Bot Design's Revisions, newest first", async () => {
    const services = await signedIn(fakeApi({ designs }));
    expect((await listDesignRevisions(services.api, "d1")).revisions.map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it("lists Maps, only one creator's if asked, and loads a Map at a Revision", async () => {
    const maps = [testMap(), testMap({ id: "m2", name: "Other", creator: { id: "p-bob_bot", username: "bob_bot", emblem: null } })];
    const api = fakeApi({ maps: maps.map((m) => (m.id === "m1" ? { ...m, latestRevision: { ...m.latestRevision, number: 2 } } : m)) });
    const services = await signedIn(api);
    expect((await listMaps(services.api, undefined)).maps.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((await listMaps(services.api, "bob_bot")).maps.map((m) => m.id)).toEqual(["m2"]);
    expect(api.requests.at(-1)).toBe("GET /maps?creator=bob_bot&limit=25");
    expect((await getMapAt(services.api, "m1", 1)).revision).toMatchObject({ number: 1, notes: "Revision 1" });
    expect(api.requests.at(-1)).toBe("GET /maps/m1/revisions/1");
    expect((await listMapRevisions(services.api, "m1")).revisions.map((r) => [r.number, r.spawnZones])).toEqual([
      [2, 2],
      [1, 2],
    ]);
  });

  it("fetches a Ruleset's Parts Catalog once per client, and again after a failure", async () => {
    const api = fakeApi();
    const services = await signedIn(api);
    const count = () => api.requests.filter((r) => r.endsWith("/parts")).length;
    const [a, b] = await Promise.all([cachedPartsCatalog(services.api, "r1"), cachedPartsCatalog(services.api, "r1")]);
    expect(a).toBe(b);
    expect(count()).toBe(1);
    await expect(cachedPartsCatalog(services.api, "r9")).rejects.toBeInstanceOf(ApiError);
    await expect(cachedPartsCatalog(services.api, "r9")).rejects.toBeInstanceOf(ApiError);
    expect(api.requests.filter((r) => r.endsWith("/r9/parts"))).toHaveLength(2);
  });
});

describe("parts", () => {
  it("draws a Build from the catalog, and a bare Chassis", () => {
    const parts = buildParts(catalog, TEST_BUILD);
    expect(parts?.chassis.id).toBe("scout");
    expect(parts?.mounted.map((m) => `${m.slot.id} ${m.component.id}`)).toEqual(["gun pelletGun", "eye radar", "drive wheels"]);
    expect(buildParts(catalog, { ...TEST_BUILD, chassis: "zeppelin" })).toBeUndefined();
    const scout = catalog.chassis[0];
    expect(scout === undefined ? undefined : bareChassisParts(catalog, scout)?.mounted).toEqual([]);
  });

  it("lists a Build's parts by Slot, then Armor by side, with costs", () => {
    const rows = buildRows(catalog, TEST_BUILD);
    const cost = (id: string) => [...catalog.chassis, ...catalog.components].find((p) => p.id === id)?.cost;
    expect(rows[0]).toEqual({ place: "Chassis", part: "Scout", cost: cost("scout") });
    expect(rows.map((r) => r.place)).toEqual(["Chassis", "Slot gun", "Slot eye", "Slot drive", "Slot bay", "Armor, front", "Armor, left", "Armor, right", "Armor, rear"]);
    expect(rows[1]).toEqual({ place: "Slot gun", part: "Pellet Gun", cost: cost("pelletGun") });
    expect(rows[4]).toEqual({ place: "Slot bay", cost: 0 });
    expect(rows[5]).toEqual({ place: "Armor, front", part: "Light Plate", cost: cost("lightPlate") });
  });

  it("names a part the catalog lacks by its id", () => {
    const rows = buildRows(catalog, { ...TEST_BUILD, components: { gun: "ray" } });
    expect(rows[1]).toEqual({ place: "Slot gun", part: "ray", cost: 0 });
  });

  it("shows stats as text", () => {
    expect(statText(12.5)).toBe("12.5");
    expect(statText("melee")).toBe("melee");
    expect(statText({ sand: { speed: 0.5, accel: 0.75 }, road: { speed: 1.2, accel: 1 } })).toBe("sand: speed ×0.5, accel ×0.75; road: speed ×1.2, accel ×1");
    expect(statText({})).toBe("none");
  });

  it("groups Components by kind in the catalog's order", () => {
    expect(componentsByKind(catalog).map(([kind, list]) => [kind, list.length])).toEqual([
      ["weapon", 10],
      ["sensor", 6],
      ["motor", 4],
      ["processor", 3],
      ["armor", 3],
    ]);
    expect(kindText("weapon")).toBe("Weapon");
    expect(kindText("pelletGun")).toBe("Pellet gun");
    expect(kindText("ram_plate")).toBe("Ram plate");
  });
});

describe("the browser screens", () => {
  const services = () => createServices({ fetch: fakeApi().fetch, storage: memoryStorage(), history: memoryHistory("/play/garage/d1") });
  const wrap = (node: ReactNode) => renderToString(<ServicesProvider services={services()}>{node}</ServicesProvider>);
  const design = testDesign({ description: "Hunts in pairs.", latestRevision: { number: 2, cost: 400, notes: "", createdAt: "2026-10-31T00:00:00.000Z" } });
  const full = { ...design, latestRevision: testDesignRevision(design, 2) };

  it("shows a Bot Design with its Build drawn, its parts, notes and Program", () => {
    const html = wrap(<DesignView design={full} revision={testDesignRevision(design, 1)} catalog={catalog} />);
    expect(html).toContain("Hunter");
    expect(html).toContain("Hunts in pairs.");
    expect(html).toContain('aria-label="Hunter&#x27;s Build"');
    expect(html).toContain("1<!-- -->, of 2");
    expect(html).toContain("Revision notes:");
    expect(html).toContain("Pellet Gun");
    expect(html).toContain("Light Plate");
    expect(html).toContain('<pre class="program">-- Hunter, Revision 1');
    expect(html).toContain('href="/play/parts?ruleset=r1"');
  });

  it("says so when a Build's Chassis is not in the catalog", () => {
    const revision = { ...testDesignRevision(design, 2), build: { ...TEST_BUILD, chassis: "zeppelin" } };
    expect(wrap(<DesignView design={full} revision={revision} catalog={catalog} />)).toContain("Ruleset r1 has no Chassis zeppelin");
  });

  it("shows a Map with its preview, size, Spawn Zones, Obstacles and Terrain", () => {
    const map = testMap();
    const html = wrap(<MapView map={map} revision={map.latestRevision} />);
    expect(html).toContain('aria-label="Duel preview"');
    expect(html).toContain("60 × 40 m");
    expect(html).toContain("2<!-- -->, so up to that many Players");
    expect(html).toContain("1<!-- -->, the latest");
    expect(html).toContain('href="/play/maps?creator=ada_bot"');
    const format = duelJson as unknown as MapFormat1;
    expect(obstaclesText(format)).toMatch(/^\d+, 2 destructible$/);
    expect(terrainText(format)).toBe(`${format.baseTerrain}, with road, sand`);
    expect(terrainText({ ...format, terrainRegions: [] })).toBe(`${format.baseTerrain} everywhere`);
    expect(obstaclesText({ ...format, obstacles: [] })).toBe("none");
  });

  it("shows every Chassis drawn and every Component by kind, drawing only Slot-mounted ones", () => {
    const html = wrap(<CatalogView catalog={catalog} />);
    for (const chassis of catalog.chassis) expect(html).toContain(`aria-label="${chassis.name} preview"`);
    expect(html).toContain("Pellet Gun preview");
    expect(html).not.toContain("Light Plate preview");
    expect(html).toContain("per side");
    expect(html).toContain('id="kind-weapon-heading">Weapon</h3>');
  });

  it("are reached from the shell's navigation", async () => {
    const html = renderToString(<App services={await signedIn(fakeApi(), "/play/parts")} />);
    for (const route of ["/garage", "/maps", "/parts"]) expect(html).toContain(`href="/play${route}"`);
  });
});

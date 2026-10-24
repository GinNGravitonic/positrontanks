import { R1_LANGUAGE } from "@aumohta/language";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { engineR1Ruleset, RulesetCatalog } from "../rulesets/catalog.js";

const config: ServerConfig = { ...defaultConfig, port: 0, databasePath: ":memory:" };
const quiet: Logger = { info: () => undefined, error: () => undefined };
const r1 = loadRuleset("r1");

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function get(path: string, catalog?: RulesetCatalog): Promise<{ status: number; body: unknown }> {
  running ??= await startServer(config, { logger: quiet, ...(catalog === undefined ? {} : { rulesets: catalog }) });
  const response = await fetch(running.url + path);
  return { status: response.status, body: await response.json() };
}

/** Round-trips through JSON, as a response body does. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const summary = { version: "r1", tickRate: 10, pointBudget: { min: 100, max: 800 }, mapFormats: [1] };

describe("Ruleset endpoints", () => {
  it("list the hosted versions", async () => {
    expect(await get("/rulesets")).toEqual({ status: 200, body: { rulesets: [summary] } });
  });

  it("summarise a version", async () => {
    expect(await get("/rulesets/r1")).toEqual({ status: 200, body: summary });
  });

  it("serve r1's rules", async () => {
    const { status, body } = await get("/rulesets/r1/rules");
    expect(status).toBe(200);
    expect(body).toEqual({ ...summary, slotTypes: r1.slotTypes, limits: json(r1.limits) });
  });

  it("serve r1's language spec", async () => {
    const { status, body } = await get("/rulesets/r1/language");
    expect(status).toBe(200);
    expect(body).toEqual(
      json({
        version: "r1",
        functions: R1_LANGUAGE.functions,
        values: R1_LANGUAGE.values,
        listMethods: R1_LANGUAGE.listMethods,
        stringMethods: R1_LANGUAGE.stringMethods,
        lengthCost: R1_LANGUAGE.lengthCost,
        limits: r1.limits,
      }),
    );
    const language = body as { functions: Record<string, { cost: number; slotArgument?: string }> };
    expect(language.functions.fire).toMatchObject({ cost: 5, slotArgument: "weapon" });
  });

  it("serve r1's Parts Catalog", async () => {
    const { status, body } = await get("/rulesets/r1/parts");
    expect(status).toBe(200);
    expect(body).toEqual(
      json({
        version: "r1",
        slotTypes: r1.slotTypes,
        chassisStats: r1.chassisStats,
        componentKinds: r1.componentKinds,
        chassis: r1.chassis,
        components: r1.components,
      }),
    );
    const catalog = body as { chassis: { id: string }[]; components: { id: string }[] };
    expect(catalog.chassis.map((c) => c.id)).toContain("scout");
    expect(catalog.components.length).toBeGreaterThan(0);
  });

  it("serve r1's Terrain table in declared order", async () => {
    const { status, body } = await get("/rulesets/r1/terrains");
    expect(status).toBe(200);
    expect(body).toEqual({ version: "r1", terrains: json(r1.terrains) });
    expect((body as { terrains: { name: string }[] }).terrains.map((t) => t.name)).toEqual([
      "grass",
      "road",
      "sand",
      "mud",
      "ice",
    ]);
  });

  it("answer 404 not_found for unknown versions, naming the hosted ones", async () => {
    for (const path of ["", "/rules", "/language", "/parts", "/terrains"]) {
      const { status, body } = await get(`/rulesets/r9${path}`);
      expect(status).toBe(404);
      const error = (body as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("not_found");
      expect(error.message).toContain("r1");
    }
  });

  it("serve each hosted version's own data side by side", async () => {
    const r1x = {
      ...engineR1Ruleset({ ...r1, version: "r1x", terrains: [{ name: "lava", speed: 0.5, accel: 0.5 }] }),
      language: {
        ...R1_LANGUAGE,
        version: "r1x",
        functions: { budgetRemaining: { minArgs: 0, maxArgs: 0, cost: 1, initPhase: true } },
      },
    };
    const catalog = new RulesetCatalog([engineR1Ruleset(r1), r1x]);
    const list = await get("/rulesets", catalog);
    expect((list.body as { rulesets: { version: string }[] }).rulesets.map((r) => r.version)).toEqual(["r1", "r1x"]);
    expect((await get("/rulesets/r1x/terrains")).body).toEqual({
      version: "r1x",
      terrains: [{ name: "lava", speed: 0.5, accel: 0.5 }],
    });
    const language = (await get("/rulesets/r1x/language")).body as { functions: Record<string, unknown> };
    expect(Object.keys(language.functions)).toEqual(["budgetRemaining"]);
    expect(Object.keys(((await get("/rulesets/r1/language")).body as typeof language).functions)).toContain("fire");
  });

  it("are described in the OpenAPI document, with every schema reference resolving", async () => {
    const { body } = await get("/openapi.json");
    const doc = body as {
      paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    const operations = Object.entries(doc.paths)
      .filter(([path]) => path.startsWith("/rulesets"))
      .map(([path, item]) => [path, item.get?.operationId, item.get?.security]);
    expect(operations).toEqual([
      ["/rulesets", "listRulesets", []],
      ["/rulesets/{version}", "getRuleset", []],
      ["/rulesets/{version}/rules", "getRulesetRules", []],
      ["/rulesets/{version}/language", "getRulesetLanguage", []],
      ["/rulesets/{version}/parts", "getPartsCatalog", []],
      ["/rulesets/{version}/terrains", "getTerrainTable", []],
    ]);
    const refs = JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z0-9]+)"/g);
    for (const [, name] of refs) expect(doc.components.schemas, name).toHaveProperty([name as string]);
  });
});

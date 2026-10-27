import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cli } from "@aumohta/cli";
import { sampleMap, TICK_COST_DEFAULT_SEED, TICK_COST_DEFAULT_TICKS, TICK_COST_MAX_TICKS } from "@aumohta/engine-r1";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";

const config: ServerConfig = {
  ...defaultConfig,
  port: 0,
  databasePath: ":memory:",
  features: { ...defaultConfig.features, tickCostCheck: true },
};
const quiet: Logger = { info: () => undefined, error: () => undefined };

let running: RunningServer;

beforeEach(async () => {
  running = await startServer(config, { logger: quiet });
});

afterEach(async () => {
  await running.close();
});

interface Response {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(running.url + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface Detail {
  path: string;
  message: string;
  line?: number;
}

const errorOf = (response: Response): { code: string; details?: Detail[] } =>
  (response.body as { error: { code: string; details?: Detail[] } }).error;

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

const noArmor = { front: null, left: null, right: null, rear: null };

/** Scout + pellet gun + radar + wheels = 84 points; the minimal Processor's 1,000 operations per Tick. */
const BUILD = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };

/** 6 operations every Tick: each built-in call costs 2, plus 1 for its literal argument. */
const STEADY = "function tick() { throttle(1); turn(0.5); }";

interface Run {
  tick: number;
  outcome: string;
  operations: number;
  memoryCells: number;
  error: { line: number; column: number; message: string } | null;
}

interface Report {
  rulesetVersion: string;
  operationBudget: number;
  seed: number;
  ticks: number;
  init: Omit<Run, "tick"> & { budget: number };
  runs: Run[];
  peak: { operations: number; tick: number } | null;
  memory: { peak: number; cap: number };
  halt: { tick: number; reason: string } | null;
}

async function checkInline(token: string, fields: Record<string, unknown>): Promise<Response> {
  return call("POST", "/tick-cost-checks", { token, body: { rulesetVersion: "r1", build: BUILD, ...fields } });
}

async function report(token: string, fields: Record<string, unknown>): Promise<Report> {
  const response = await checkInline(token, fields);
  expect(response.status).toBe(200);
  return response.body as Report;
}

let ada: string;

beforeEach(async () => {
  ada = await player("ada");
});

describe("checking a Program's tick cost", () => {
  it("reports the operations of every Tick and the peak", async () => {
    const body = await report(ada, { program: STEADY });
    expect(body).toMatchObject({
      rulesetVersion: "r1",
      operationBudget: 1000,
      seed: TICK_COST_DEFAULT_SEED,
      ticks: TICK_COST_DEFAULT_TICKS,
      init: { outcome: "completed", operations: 0, budget: 50_000, error: null },
      peak: { operations: 6, tick: 1 },
      memory: { peak: 0, cap: 10_000 },
      halt: null,
    });
    expect(body.runs).toHaveLength(TICK_COST_DEFAULT_TICKS);
    expect(body.runs.map((r) => r.tick)).toEqual(Array.from({ length: TICK_COST_DEFAULT_TICKS }, (_, i) => i + 1));
    expect(body.runs.every((r) => r.operations === 6 && r.outcome === "completed")).toBe(true);
  });

  it("finds the peak Tick of a Program whose cost grows, and reports memory", async () => {
    const program = `let n = 0;
let history = [];
function tick() {
  n++;
  let i = 0;
  while (i < n) { i++; }
  history.push(i);
}`;
    const body = await report(ada, { program, ticks: 5 });
    const operations = body.runs.map((r) => r.operations);
    expect(operations).toHaveLength(5);
    for (let i = 1; i < operations.length; i++) expect(operations[i]).toBeGreaterThan(operations[i - 1] ?? 0);
    expect(body.peak).toEqual({ operations: Math.max(...operations), tick: 5 });
    // n (1 cell) plus history (1 + 1 per number): 3 cells after Tick 1, up to 7 after Tick 5.
    expect(body.runs.map((r) => r.memoryCells)).toEqual([3, 4, 5, 6, 7]);
    expect(body.memory).toEqual({ peak: 7, cap: 10_000 });
  });

  it("shows a Tick that runs out of budget", async () => {
    const body = await report(ada, { program: "function tick() { while (true) {} }", ticks: 3 });
    expect(body.runs).toHaveLength(3);
    for (const run of body.runs) {
      expect(run.outcome).toBe("outOfBudget");
      expect(run.operations).toBeLessThanOrEqual(1000);
      expect(run.error?.message).toBe("the Operation Budget is exhausted");
    }
    expect(body.peak?.tick).toBe(1);
    expect(body.halt).toBeNull();
  });

  it("uses the Build's Processor for the budget", async () => {
    const build = { ...BUILD, components: { ...BUILD.components, bay: "coprocessor" } };
    const body = await report(ada, { build, program: "function tick() { while (true) {} }", ticks: 1 });
    expect(body.operationBudget).toBe(2000);
    expect(body.peak?.operations).toBeGreaterThan(1000);
  });

  it("runs against a sample Foe the Program can see", async () => {
    // Without a contact, the Program burns its whole budget.
    const program = `function tick() {
  const contacts = scan();
  if (contacts.length == 0 || !contacts[0].isFoe) { while (true) {} }
}`;
    const body = await report(ada, { program, ticks: 3 });
    expect(body.runs.map((r) => r.outcome)).toEqual(["completed", "completed", "completed"]);
  });

  it("reports a Program that halts in its init phase, with no Ticks", async () => {
    const body = await report(ada, { program: "function init() { while (true) {} }\nfunction tick() {}" });
    expect(body.init).toMatchObject({ outcome: "outOfBudget", budget: 50_000 });
    expect(body.halt?.tick).toBe(0);
    expect(body.runs).toEqual([]);
    expect(body.peak).toBeNull();
  });

  it("is deterministic and honours the seed", async () => {
    const program = "let r = 0; function tick() { if (random() < 0.5) { r = r + 1; } }";
    const first = await report(ada, { program, seed: 7 });
    expect(await report(ada, { program, seed: 7 })).toEqual(first);
    expect(first.seed).toBe(7);
  });

  it("validates the Build and Program as saving does, and the options", async () => {
    const bad = await checkInline(ada, { program: 'function tick() { fire("nope", 0); }' });
    expect(bad.status).toBe(422);
    expect(errorOf(bad).details?.[0]).toMatchObject({ path: "program", line: 1 });

    const options = await checkInline(ada, { program: STEADY, ticks: TICK_COST_MAX_TICKS + 1, seed: -1 });
    expect(options.status).toBe(422);
    expect(errorOf(options).details?.map((d) => d.path)).toEqual(["ticks", "seed"]);

    const unknown = await call("POST", "/tick-cost-checks", { token: ada, body: { rulesetVersion: "r9", build: BUILD, program: STEADY } });
    expect(errorOf(unknown).details?.map((d) => d.path)).toEqual(["rulesetVersion"]);

    const missing = await call("POST", "/tick-cost-checks", { token: ada, body: { build: BUILD, extra: 1 } });
    expect(errorOf(missing).details?.map((d) => d.path).sort()).toEqual(["extra", "program", "rulesetVersion"]);
  });

  it("requires authentication", async () => {
    expect((await call("POST", "/tick-cost-checks", { body: { rulesetVersion: "r1", build: BUILD, program: STEADY } })).status).toBe(401);
  });
});

describe("agreement with the CLI", () => {
  /** `aumohta tick-cost --json` for one Bot with the Build and Program, and the report it prints. */
  async function cliReport(program: string, ...options: string[]): Promise<Report> {
    const dir = await mkdtemp(join(tmpdir(), "aumohta-tick-cost-"));
    try {
      const entry = join(dir, "ada.entry.json");
      await writeFile(entry, JSON.stringify({ ruleset: "r1", bots: [{ name: "Probe", build: BUILD, program }] }));
      const out: string[] = [];
      const code = await cli(["tick-cost", "--entry", entry, "--json", ...options], { out: (l) => out.push(l), err: (l) => out.push(l) });
      expect(code).toBe(0);
      const [bot] = (JSON.parse(out.join("\n")) as { bots: { report: Report }[] }).bots;
      if (bot === undefined) throw new Error("the CLI reported no Bot");
      return bot.report;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("aumohta tick-cost reports the same numbers as the endpoint, with the same defaults", async () => {
    expect(await cliReport(STEADY)).toEqual(await report(ada, { program: STEADY }));
    const program = "let seen = []; function tick() { if (random() < 0.5) { seen.push(scan().length); } while (random() < 0.9) {} }";
    expect(await cliReport(program, "--ticks", "37", "--seed", "4242")).toEqual(await report(ada, { program, ticks: 37, seed: 4242 }));
  });
});

interface Design {
  id: string;
}

async function design(token: string, program: string): Promise<Design> {
  const response = await call("POST", "/bot-designs", { token, body: { name: "Probe", rulesetVersion: "r1", build: BUILD, program } });
  expect(response.status).toBe(201);
  return response.body as Design;
}

describe("checking a Bot Design Revision", () => {
  it("checks the latest Revision, or the one asked for", async () => {
    const { id } = await design(ada, STEADY);
    const grown = "function tick() { throttle(1); turn(0.5); turn(0.5); }";
    expect((await call("POST", `/bot-designs/${id}/revisions`, { token: ada, body: { build: BUILD, program: grown } })).status).toBe(201);

    const latest = await call("POST", `/bot-designs/${id}/tick-cost-checks`, { token: ada, body: {} });
    expect(latest.status).toBe(200);
    expect((latest.body as Report).peak).toEqual({ operations: 9, tick: 1 });
    expect(latest.body).toEqual(await report(ada, { program: grown }));

    const first = await call("POST", `/bot-designs/${id}/tick-cost-checks`, { token: ada, body: { revision: 1, ticks: 2 } });
    expect(first.status).toBe(200);
    expect((first.body as Report).runs.map((r) => r.operations)).toEqual([6, 6]);
  });

  it("answers 404 for unknown designs and Revisions, and validates options", async () => {
    const { id } = await design(ada, STEADY);
    expect((await call("POST", "/bot-designs/nope/tick-cost-checks", { token: ada, body: {} })).status).toBe(404);
    expect((await call("POST", `/bot-designs/${id}/tick-cost-checks`, { token: ada, body: { revision: 2 } })).status).toBe(404);
    const bad = await call("POST", `/bot-designs/${id}/tick-cost-checks`, { token: ada, body: { revision: 0, ticks: 0 } });
    expect(errorOf(bad).details?.map((d) => d.path)).toEqual(["ticks", "revision"]);
    expect((await call("POST", `/bot-designs/${id}/tick-cost-checks`, { body: {} })).status).toBe(401);
  });
});

describe("privacy", () => {
  it("never checks, or reveals anything of, another Player's design", async () => {
    const secret = 'function tick() { log("grace-secret-plan"); throttle(1); }';
    const graces = await design(await player("grace"), secret);

    const response = await call("POST", `/bot-designs/${graces.id}/tick-cost-checks`, { token: ada, body: {} });
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("not_found");
    expect(JSON.stringify(response.body)).not.toContain("grace-secret-plan");
    // Exactly what a design that does not exist answers.
    const missing = await call("POST", `/bot-designs/no-such-design/tick-cost-checks`, { token: ada, body: {} });
    expect(errorOf(missing).code).toBe(errorOf(response).code);
  });

  it("reports only the checked Bot, in a world no other Player's data reaches", async () => {
    const before = await report(ada, { program: STEADY });

    // Another Player saves designs and a Map; the sample world does not change.
    const grace = await player("grace");
    const graces = await design(grace, 'function tick() { log("grace-secret-plan"); while (true) {} }');
    const map = { ...sampleMap(loadRuleset("r1")), obstacles: [] };
    expect((await call("POST", "/maps", { token: grace, body: { name: "Grace's arena", map } })).status).toBe(201);

    const after = await checkInline(ada, { program: STEADY });
    expect(after.body).toEqual(before);
    const text = JSON.stringify(after.body);
    for (const leak of ["grace", graces.id, "Grace's arena"]) expect(text).not.toContain(leak);
    // One run per Tick: the sample Foe's runs are not included.
    expect(before.runs).toHaveLength(before.ticks);
  });
});

describe("on a server that does not enable the check", () => {
  beforeEach(async () => {
    await running.close();
    running = await startServer({ ...config, features: defaultConfig.features }, { logger: quiet });
  });

  it("answers 410 feature_disabled, not to be cached", async () => {
    const token = await player("ada");
    const id = (await design(token, STEADY)).id;
    for (const path of ["/tick-cost-checks", `/bot-designs/${id}/tick-cost-checks`]) {
      const body = path === "/tick-cost-checks" ? { rulesetVersion: "r1", build: BUILD, program: STEADY } : {};
      const response = await fetch(running.url + path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("feature_disabled");
      expect(error.message).toContain("docs/docker.md");
      expect(error.message).toContain("aumohta tick-cost");
    }
  });

  it("is reported off by GET /server", async () => {
    expect(await call("GET", "/server")).toEqual({ status: 200, body: { features: { tickCostCheck: false } } });
  });
});

describe("GET /server", () => {
  it("reports the check enabled", async () => {
    expect(await call("GET", "/server")).toEqual({ status: 200, body: { features: { tickCostCheck: true } } });
  });
});

describe("the OpenAPI document", () => {
  it("describes the tick cost endpoints", async () => {
    const doc = (await call("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { operationId: string; tags: string[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths["/tick-cost-checks"]?.post?.operationId).toBe("checkTickCost");
    expect(doc.paths["/bot-designs/{designId}/tick-cost-checks"]?.post).toMatchObject({
      operationId: "checkBotDesignTickCost",
      tags: ["Garage"],
    });
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["TickCostCheck", "BotDesignTickCostCheck", "TickCostReport"]),
    );
  });
});

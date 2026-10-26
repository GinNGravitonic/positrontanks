import { R1_LANGUAGE } from "@aumohta/language";
import { loadRuleset } from "@aumohta/ruleset-data/rulesets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Logger, type RunningServer } from "../app.js";
import { defaultConfig, type ServerConfig } from "../config.js";
import { engineR1Ruleset, RulesetCatalog, type HostedRuleset } from "../rulesets/catalog.js";

const config: ServerConfig = { ...defaultConfig, port: 0, databasePath: ":memory:" };
const quiet: Logger = { info: () => undefined, error: () => undefined };

const r1 = loadRuleset("r1");

/**
 * A second Ruleset version to copy into: r1 without the rangefinder
 * Component, with a Point Budget capped at 70, and without the `incoming`
 * built-in.
 */
const r1x: HostedRuleset = (() => {
  const ruleset = {
    ...r1,
    version: "r1x",
    pointBudget: { min: 40, max: 70 },
    components: r1.components.filter((c) => c.id !== "rangefinder"),
  };
  const functions = Object.fromEntries(Object.entries(R1_LANGUAGE.functions).filter(([name]) => name !== "incoming"));
  return { ...engineR1Ruleset(ruleset), language: { ...R1_LANGUAGE, version: "r1x", functions } };
})();

let running: RunningServer;

beforeEach(async () => {
  running = await startServer(config, {
    logger: quiet,
    rulesets: new RulesetCatalog([engineR1Ruleset(r1), r1x]),
  });
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
  column?: number;
}

const errorOf = (response: Response): { code: string; details?: Detail[] } =>
  (response.body as { error: { code: string; details?: Detail[] } }).error;

async function player(username: string): Promise<string> {
  const password = "correct horse battery";
  expect((await call("POST", "/players", { body: { username, password } })).status).toBe(201);
  return ((await call("POST", "/sessions", { body: { username, password } })).body as { token: string }).token;
}

interface Build {
  chassis: string;
  components: Record<string, string>;
  armor: Record<string, string | null>;
}

const noArmor = { front: null, left: null, right: null, rear: null };

/** Scout (40) + pellet gun (12) + rangefinder (5) + wheels (12) + light front plate (5) = 74 points. */
const BUILD: Build = {
  chassis: "scout",
  components: { gun: "pelletGun", eye: "rangefinder", drive: "wheels" },
  armor: { ...noArmor, front: "lightPlate" },
};

const PROGRAM = `function tick() {
  throttle(1);
  rangefind("eye");
  fire("gun", 0);
}`;

/** Scout + pellet gun + wheels = 64 points, valid under both Rulesets. */
const CHEAP_BUILD: Build = { chassis: "scout", components: { gun: "pelletGun", drive: "wheels" }, armor: noArmor };
const CHEAP_PROGRAM = `function tick() { throttle(1); fire("gun", 0); }`;

interface Revision {
  designId: string;
  number: number;
  build: Build;
  program: string;
  cost: number;
  createdAt: string;
}

interface Design {
  id: string;
  name: string;
  description: string;
  rulesetVersion: string;
  latestRevision: Revision;
  copiedFrom: { designId: string; revision: number } | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface Summary extends Omit<Design, "latestRevision"> {
  latestRevision: { number: number; cost: number; createdAt: string };
}

async function create(
  token: string,
  fields: { name?: string; description?: string; rulesetVersion?: string; build?: Build; program?: string } = {},
): Promise<Design> {
  const response = await call("POST", "/bot-designs", {
    token,
    body: { name: "Scout", rulesetVersion: "r1", build: BUILD, program: PROGRAM, ...fields },
  });
  expect(response.status).toBe(201);
  return response.body as Design;
}

async function list(token: string, query = ""): Promise<Summary[]> {
  const response = await call("GET", `/bot-designs${query}`, { token });
  expect(response.status).toBe(200);
  return (response.body as { botDesigns: Summary[] }).botDesigns;
}

let ada: string;

beforeEach(async () => {
  ada = await player("ada");
});

describe("creating a Bot Design", () => {
  it("saves Revision 1 with the Build, Program and cost", async () => {
    const design = await create(ada, { name: "  Pellet Scout  " });
    expect(design).toMatchObject({
      name: "Pellet Scout",
      description: "",
      rulesetVersion: "r1",
      copiedFrom: null,
      archivedAt: null,
      latestRevision: { designId: design.id, number: 1, build: BUILD, program: PROGRAM, cost: 74 },
    });
    expect(Object.keys(design).sort()).toEqual(
      ["archivedAt", "copiedFrom", "createdAt", "description", "id", "latestRevision", "name", "rulesetVersion", "updatedAt"],
    );

    const fetched = await call("GET", `/bot-designs/${design.id}`, { token: ada });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(design);
  });

  it("accepts a description, trimmed, of at most 2000 characters", async () => {
    const design = await create(ada, { description: "  Fast and\nfragile.  " });
    expect(design.description).toBe("Fast and\nfragile.");
    expect((await list(ada))[0]?.description).toBe("Fast and\nfragile.");
    expect((await create(ada, { description: "d".repeat(2000) })).description).toHaveLength(2000);

    const long = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "x", description: "d".repeat(2001), rulesetVersion: "r1", build: BUILD, program: PROGRAM },
    });
    expect(long.status).toBe(422);
    expect(errorOf(long).details).toEqual([{ path: "description", message: "must be at most 2000 characters" }]);
    const typed = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "x", description: 5, rulesetVersion: "r1", build: BUILD, program: PROGRAM },
    });
    expect(errorOf(typed).details).toEqual([{ path: "description", message: "must be a string" }]);
    expect(await list(ada)).toHaveLength(2);
  });

  it("requires authentication", async () => {
    const response = await call("POST", "/bot-designs", { body: { name: "x", rulesetVersion: "r1", build: BUILD, program: PROGRAM } });
    expect(response.status).toBe(401);
    expect((await call("GET", "/bot-designs")).status).toBe(401);
  });

  it("reports every Build and Program problem at once and saves nothing", async () => {
    const response = await call("POST", "/bot-designs", {
      token: ada,
      body: {
        name: "Broken",
        rulesetVersion: "r1",
        build: {
          chassis: "scout",
          components: { gun: "radar", eye: "laserBeam", wing: "wheels" },
          armor: { ...noArmor, front: "pelletGun" },
        },
        program: "function tick() {\n  let x = ;\n}",
      },
    });
    expect(response.status).toBe(422);
    const error = errorOf(response);
    expect(error.code).toBe("validation_failed");
    const paths = (error.details ?? []).map((d) => d.path).sort();
    expect(paths).toEqual([
      "build.armor.front",
      "build.components.eye",
      "build.components.gun",
      "build.components.wing",
      "program",
    ]);
    const program = error.details?.find((d) => d.path === "program");
    expect(program).toMatchObject({ line: 2 });
    expect(typeof program?.column).toBe("number");
    expect(await list(ada)).toEqual([]);
  });

  it("checks literal Slot ids in the Program against the Build", async () => {
    const response = await call("POST", "/bot-designs", {
      token: ada,
      body: {
        name: "Wrong slots",
        rulesetVersion: "r1",
        build: CHEAP_BUILD,
        program: `function tick() {\n  fire("eye", 0);\n  rangefind("gun");\n}`,
      },
    });
    expect(response.status).toBe(422);
    const details = errorOf(response).details ?? [];
    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({ path: "program", line: 2 });
    expect(details[0]?.message).toContain("no weapon in Slot 'eye'");
    expect(details[1]).toMatchObject({ path: "program", line: 3 });
    expect(details[1]?.message).toContain("no rangefinder");
  });

  it("rejects unknown names and a missing tick", async () => {
    const response = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "x", rulesetVersion: "r1", build: CHEAP_BUILD, program: "function init() { teleport(); }" },
    });
    expect(response.status).toBe(422);
    const messages = (errorOf(response).details ?? []).map((d) => d.message).join("\n");
    expect(messages).toContain("teleport");
    expect(messages).toContain("tick");
  });

  it("rejects a Build costing more than the Ruleset's largest Point Budget", async () => {
    // 64 + medium plate (12) = 76, over r1x's 70.
    const over = await call("POST", "/bot-designs", {
      token: ada,
      body: {
        name: "Pricey",
        rulesetVersion: "r1x",
        build: { ...CHEAP_BUILD, armor: { ...noArmor, front: "mediumPlate" } },
        program: CHEAP_PROGRAM,
      },
    });
    expect(over.status).toBe(422);
    expect(errorOf(over).details).toEqual([
      { path: "build", message: "costs 76 points, more than Ruleset r1x's largest Point Budget of 70" },
    ]);
  });

  it("rejects an unknown Ruleset version, bad names, and missing or unknown fields", async () => {
    const unknown = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "", rulesetVersion: "r9", build: BUILD, program: PROGRAM },
    });
    expect(unknown.status).toBe(422);
    expect((errorOf(unknown).details ?? []).map((d) => d.path).sort()).toEqual(["name", "rulesetVersion"]);
    expect(errorOf(unknown).details?.find((d) => d.path === "rulesetVersion")?.message).toContain("r1, r1x");

    const long = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "n".repeat(65), rulesetVersion: "r1", build: BUILD, program: PROGRAM },
    });
    expect(errorOf(long).details).toEqual([{ path: "name", message: "must be 1 to 64 characters" }]);

    const messy = await call("POST", "/bot-designs", { token: ada, body: { name: "x", extra: 1 } });
    expect(messy.status).toBe(422);
    expect((errorOf(messy).details ?? []).map((d) => d.path).sort()).toEqual(["build", "extra", "program", "rulesetVersion"]);

    const typed = await call("POST", "/bot-designs", {
      token: ada,
      body: { name: "x", rulesetVersion: "r1", build: "scout", program: 42 },
    });
    expect((errorOf(typed).details ?? []).map((d) => d.path).sort()).toEqual(["build", "program"]);
  });
});

describe("Revisions", () => {
  it("are added by edits, numbered, and never change", async () => {
    const design = await create(ada);
    const program2 = `function tick() { throttle(0.5); fire("gun", 10); }`;
    const added = await call("POST", `/bot-designs/${design.id}/revisions`, {
      token: ada,
      body: { build: CHEAP_BUILD, program: program2 },
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ designId: design.id, number: 2, build: CHEAP_BUILD, program: program2, cost: 64 });

    const first = await call("GET", `/bot-designs/${design.id}/revisions/1`, { token: ada });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(design.latestRevision);

    const latest = (await call("GET", `/bot-designs/${design.id}`, { token: ada })).body as Design;
    expect(latest.latestRevision).toEqual(added.body);
    expect(latest.createdAt).toBe(design.createdAt);

    const revisions = await call("GET", `/bot-designs/${design.id}/revisions`, { token: ada });
    expect(revisions.status).toBe(200);
    expect((revisions.body as { revisions: { number: number; cost: number }[] }).revisions).toMatchObject([
      { number: 2, cost: 64 },
      { number: 1, cost: 74 },
    ]);
  });

  it("are validated like a new design, and an invalid edit adds nothing", async () => {
    const design = await create(ada);
    const invalid = await call("POST", `/bot-designs/${design.id}/revisions`, {
      token: ada,
      body: { build: CHEAP_BUILD, program: PROGRAM },
    });
    expect(invalid.status).toBe(422);
    expect(errorOf(invalid).details?.[0]).toMatchObject({ path: "program", line: 3 });

    const missing = await call("POST", `/bot-designs/${design.id}/revisions`, { token: ada, body: { program: PROGRAM } });
    expect(errorOf(missing).details).toEqual([{ path: "build", message: "is required" }]);

    const revisions = (await call("GET", `/bot-designs/${design.id}/revisions`, { token: ada })).body as {
      revisions: unknown[];
    };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("answer 404 for unknown designs and Revision numbers", async () => {
    const design = await create(ada);
    for (const path of [
      `/bot-designs/${design.id}/revisions/2`,
      `/bot-designs/${design.id}/revisions/0`,
      `/bot-designs/${design.id}/revisions/one`,
      `/bot-designs/nope/revisions/1`,
      `/bot-designs/nope/revisions`,
      `/bot-designs/nope`,
    ]) {
      const response = await call("GET", path, { token: ada });
      expect(response.status, path).toBe(404);
      expect(errorOf(response).code).toBe("not_found");
    }
    const post = await call("POST", "/bot-designs/nope/revisions", { token: ada, body: { build: BUILD, program: PROGRAM } });
    expect(post.status).toBe(404);
  });
});

describe("listing, renaming and describing", () => {
  it("lists the Player's designs without Programs", async () => {
    const a = await create(ada, { name: "A" });
    const b = await create(ada, { name: "B", rulesetVersion: "r1x", build: CHEAP_BUILD, program: CHEAP_PROGRAM });
    await call("POST", `/bot-designs/${a.id}/revisions`, { token: ada, body: { build: BUILD, program: PROGRAM } });

    const designs = await list(ada);
    expect(designs.map((d) => d.name).sort()).toEqual(["A", "B"]);
    expect(designs.find((d) => d.id === a.id)?.latestRevision).toMatchObject({ number: 2, cost: 74 });
    expect(JSON.stringify(designs)).not.toContain("throttle");

    expect((await list(ada, "?rulesetVersion=r1x")).map((d) => d.id)).toEqual([b.id]);
    expect((await call("GET", "/bot-designs?includeArchived=maybe", { token: ada })).status).toBe(400);
  });

  it("renames without adding a Revision", async () => {
    const design = await create(ada);
    const renamed = await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: { name: "Renamed" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", latestRevision: { number: 1 } });

    const bad = await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: { name: " " } });
    expect(bad.status).toBe(422);
    expect((await call("PATCH", "/bot-designs/nope", { token: ada, body: { name: "x" } })).status).toBe(404);
  });

  it("changes the name and description, together or apart, keeping what is left out", async () => {
    const design = await create(ada, { name: "Old", description: "Old notes" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const described = await call("PATCH", `/bot-designs/${design.id}`, {
      token: ada,
      body: { description: "  Circles left.  " },
    });
    expect(described.status).toBe(200);
    const after = described.body as Design;
    expect(after).toMatchObject({ name: "Old", description: "Circles left.", latestRevision: design.latestRevision });
    expect(after.updatedAt > design.updatedAt).toBe(true);
    expect(after.createdAt).toBe(design.createdAt);

    const both = await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: { name: "New", description: "" } });
    expect(both.body).toMatchObject({ name: "New", description: "" });
    expect((await call("GET", `/bot-designs/${design.id}`, { token: ada })).body).toEqual(both.body);
    const revisions = (await call("GET", `/bot-designs/${design.id}/revisions`, { token: ada })).body as {
      revisions: unknown[];
    };
    expect(revisions.revisions).toHaveLength(1);
  });

  it("rejects empty, unknown and invalid changes", async () => {
    const design = await create(ada);
    const empty = await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: {} });
    expect(empty.status).toBe(422);
    expect(errorOf(empty).details).toEqual([{ path: "(body)", message: "must have a name or a description to change" }]);

    const bad = await call("PATCH", `/bot-designs/${design.id}`, {
      token: ada,
      body: { name: "", description: "d".repeat(2001), program: "x" },
    });
    expect(errorOf(bad).details?.map((d) => d.path)).toEqual(["program", "name", "description"]);
    expect((await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: [] })).status).toBe(422);
    expect((await call("PATCH", `/bot-designs/${design.id}`, { body: { name: "x" } })).status).toBe(401);
    expect((await call("GET", `/bot-designs/${design.id}`, { token: ada })).body).toEqual(design);
  });
});

describe("archiving", () => {
  it("hides a design from listings but keeps it and its Revisions readable", async () => {
    const kept = await create(ada, { name: "Kept" });
    const gone = await create(ada, { name: "Gone" });

    const archived = await call("DELETE", `/bot-designs/${gone.id}`, { token: ada });
    expect(archived.status).toBe(204);

    expect((await list(ada)).map((d) => d.id)).toEqual([kept.id]);
    const all = await list(ada, "?includeArchived=true");
    expect(all.map((d) => d.id).sort()).toEqual([kept.id, gone.id].sort());
    expect(all.find((d) => d.id === gone.id)?.archivedAt).not.toBeNull();

    const read = await call("GET", `/bot-designs/${gone.id}`, { token: ada });
    expect(read.status).toBe(200);
    expect((read.body as Design).archivedAt).not.toBeNull();
    expect((await call("GET", `/bot-designs/${gone.id}/revisions/1`, { token: ada })).body).toEqual(gone.latestRevision);
  });

  it("refuses new Revisions but allows renaming and describing, and is idempotent", async () => {
    const design = await create(ada);
    await call("DELETE", `/bot-designs/${design.id}`, { token: ada });
    const first = ((await call("GET", `/bot-designs/${design.id}`, { token: ada })).body as Design).archivedAt;

    const edit = await call("POST", `/bot-designs/${design.id}/revisions`, { token: ada, body: { build: BUILD, program: PROGRAM } });
    expect(edit.status).toBe(409);
    expect(errorOf(edit).code).toBe("design_archived");
    const rename = await call("PATCH", `/bot-designs/${design.id}`, { token: ada, body: { name: "x", description: "Retired" } });
    expect(rename.status).toBe(200);
    expect(rename.body).toMatchObject({ name: "x", description: "Retired", archivedAt: first });

    expect((await call("DELETE", `/bot-designs/${design.id}`, { token: ada })).status).toBe(204);
    expect(((await call("GET", `/bot-designs/${design.id}`, { token: ada })).body as Design).archivedAt).toBe(first);
    expect((await call("DELETE", "/bot-designs/nope", { token: ada })).status).toBe(404);
  });

  it("still allows copying to another Ruleset", async () => {
    const design = await create(ada, { build: CHEAP_BUILD, program: CHEAP_PROGRAM });
    await call("DELETE", `/bot-designs/${design.id}`, { token: ada });
    const copy = await call("POST", `/bot-designs/${design.id}/copies`, { token: ada, body: { rulesetVersion: "r1x" } });
    expect(copy.status).toBe(201);
    expect((copy.body as { botDesign: Design }).botDesign.archivedAt).toBeNull();
  });
});

describe("copy to Ruleset", () => {
  it("saves a valid copy as a new design at Revision 1, leaving the source alone", async () => {
    const source = await create(ada, { name: "Cheap", description: "Notes", build: CHEAP_BUILD, program: CHEAP_PROGRAM });
    const response = await call("POST", `/bot-designs/${source.id}/copies`, { token: ada, body: { rulesetVersion: "r1x" } });
    expect(response.status).toBe(201);
    const { botDesign, report } = response.body as { botDesign: Design; report: unknown };
    expect(report).toEqual({ rulesetVersion: "r1x", sourceRevision: 1, ok: true, cost: 64, problems: [] });
    expect(botDesign.id).not.toBe(source.id);
    expect(botDesign).toMatchObject({
      name: "Cheap",
      description: "Notes",
      rulesetVersion: "r1x",
      copiedFrom: { designId: source.id, revision: 1 },
      latestRevision: { number: 1, build: CHEAP_BUILD, program: CHEAP_PROGRAM, cost: 64 },
    });

    const after = (await call("GET", `/bot-designs/${source.id}`, { token: ada })).body as Design;
    expect(after).toEqual(source);
    expect(await list(ada)).toHaveLength(2);
  });

  it("can copy an earlier Revision under a new name", async () => {
    const source = await create(ada, { build: CHEAP_BUILD, program: CHEAP_PROGRAM });
    await call("POST", `/bot-designs/${source.id}/revisions`, { token: ada, body: { build: BUILD, program: PROGRAM } });
    const response = await call("POST", `/bot-designs/${source.id}/copies`, {
      token: ada,
      body: { rulesetVersion: "r1x", revision: 1, name: "Old cheap" },
    });
    expect(response.status).toBe(201);
    expect((response.body as { botDesign: Design }).botDesign).toMatchObject({
      name: "Old cheap",
      copiedFrom: { designId: source.id, revision: 1 },
    });
    const missing = await call("POST", `/bot-designs/${source.id}/copies`, { token: ada, body: { rulesetVersion: "r1x", revision: 9 } });
    expect(missing.status).toBe(404);
  });

  it("reports removed Components and unknown built-ins without saving", async () => {
    const program = `function tick() {\n  throttle(1);\n  incoming();\n}`;
    const source = await create(ada, { program });

    const dry = await call("POST", `/bot-designs/${source.id}/copies`, {
      token: ada,
      body: { rulesetVersion: "r1x", dryRun: true },
    });
    expect(dry.status).toBe(200);
    const report = dry.body as { ok: boolean; cost: number | null; problems: Detail[]; sourceRevision: number };
    expect(report.ok).toBe(false);
    expect(report.cost).toBeNull();
    expect(report.sourceRevision).toBe(1);
    expect(report.problems.map((p) => p.path)).toEqual(["build.components.eye", "program"]);
    expect(report.problems[0]?.message).toContain('unknown Component "rangefinder"');
    expect(report.problems[1]).toMatchObject({ line: 3 });
    expect(report.problems[1]?.message).toContain("incoming");

    const real = await call("POST", `/bot-designs/${source.id}/copies`, { token: ada, body: { rulesetVersion: "r1x" } });
    expect(real.status).toBe(422);
    expect(errorOf(real)).toMatchObject({ code: "copy_has_problems", details: report.problems });
    expect(await list(ada)).toHaveLength(1);
  });

  it("reports a Build over the target Ruleset's largest Point Budget", async () => {
    const source = await create(ada, { build: { ...CHEAP_BUILD, armor: { ...noArmor, rear: "heavyPlate" } }, program: CHEAP_PROGRAM });
    const dry = await call("POST", `/bot-designs/${source.id}/copies`, {
      token: ada,
      body: { rulesetVersion: "r1x", dryRun: true },
    });
    expect(dry.body).toEqual({
      rulesetVersion: "r1x",
      sourceRevision: 1,
      ok: false,
      cost: 86,
      problems: [{ path: "build", message: "costs 86 points, more than Ruleset r1x's largest Point Budget of 70" }],
    });
  });

  it("rejects an unknown target version and bad options", async () => {
    const source = await create(ada);
    const response = await call("POST", `/bot-designs/${source.id}/copies`, {
      token: ada,
      body: { rulesetVersion: "r2", revision: 0, dryRun: "yes", name: "" },
    });
    expect(response.status).toBe(422);
    expect((errorOf(response).details ?? []).map((d) => d.path).sort()).toEqual(["dryRun", "name", "revision", "rulesetVersion"]);
  });
});

describe("privacy", () => {
  it("keeps designs, Revisions, Programs and descriptions invisible to other Players", async () => {
    const design = await create(ada, { description: "private-notes" });
    const grace = await player("grace");

    expect(await list(grace)).toEqual([]);
    expect(await list(grace, "?includeArchived=true")).toEqual([]);

    const attempts: [string, string, unknown?][] = [
      ["GET", `/bot-designs/${design.id}`],
      ["GET", `/bot-designs/${design.id}/revisions`],
      ["GET", `/bot-designs/${design.id}/revisions/1`],
      ["POST", `/bot-designs/${design.id}/revisions`, { build: BUILD, program: PROGRAM }],
      ["POST", `/bot-designs/${design.id}/copies`, { rulesetVersion: "r1" }],
      ["POST", `/bot-designs/${design.id}/copies`, { rulesetVersion: "r1", dryRun: true }],
      ["PATCH", `/bot-designs/${design.id}`, { name: "Mine now" }],
      ["PATCH", `/bot-designs/${design.id}`, { description: "Mine now" }],
      ["DELETE", `/bot-designs/${design.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, { token: grace, ...(body === undefined ? {} : { body }) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("rangefind");
      expect(JSON.stringify(response.body)).not.toContain("private-notes");
    }

    // Nothing the other Player tried changed the design.
    const mine = (await call("GET", `/bot-designs/${design.id}`, { token: ada })).body as Design;
    expect(mine).toEqual(design);
    expect(await list(grace)).toEqual([]);
  });
});

describe("the OpenAPI document", () => {
  it("describes the Garage endpoints", async () => {
    const doc = (await call("GET", "/openapi.json")).body as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const operations = Object.values(doc.paths)
      .flatMap((item) => Object.values(item).map((op) => op.operationId))
      .filter((id) => /BotDesign/.test(id))
      .sort();
    expect(operations).toEqual([
      "archiveBotDesign",
      "checkBotDesignTickCost",
      "copyBotDesignToRuleset",
      "createBotDesign",
      "createBotDesignRevision",
      "deleteBotDesignRevision",
      "getBotDesign",
      "getBotDesignRevision",
      "listBotDesignRevisions",
      "listBotDesigns",
      "updateBotDesign",
    ]);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(["BotDesign", "Build", "CopyReport"]));
  });
});

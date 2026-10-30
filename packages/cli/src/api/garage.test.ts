import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type Schema } from "./client.js";
import type { components } from "./schema.js";
import { startTestServer, type CliRun, type TestServer } from "./test-server.js";

const duelMap = fileURLToPath(new URL("../../../ruleset-data/maps/duel.json", import.meta.url));
const pw = { stdin: "correct horse battery\n" };
const noArmor = { front: null, left: null, right: null, rear: null };
const BUILD = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };
const PROGRAM = "function tick() {\n  throttle(1);\n}\n";

let server: TestServer;
let dir: string;
let client: ApiClient;

beforeEach(async () => {
  server = await startTestServer();
  dir = await mkdtemp(join(tmpdir(), "positrontanks-cli-garage-"));
  await writeFile(at("build.json"), JSON.stringify(BUILD));
  await writeFile(at("hunter.ptk"), PROGRAM);
  await copyFile(duelMap, at("duel.json"));
  expect((await server.cli(["auth", "signup", "ada", "--password-stdin"], pw)).code).toBe(0);
  expect((await server.cli(["auth", "login", "ada", "--password-stdin"], pw)).code).toBe(0);
  client = new ApiClient(server.url, (await server.config())?.profiles.default?.apiKey);
});

afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const at = (file: string) => join(dir, file);
const cli = (...argv: string[]) => server.cli(argv);
/** The JSON a successful run printed. */
const body = (run: CliRun): unknown => {
  expect(run).toMatchObject({ code: 0, err: "" });
  return JSON.parse(run.out);
};
/** body, as the API schema `name`. */
const json = <Name extends keyof components["schemas"]>(name: Name, run: CliRun) => body(run) as Schema<Name>;
const errorOf = (run: CliRun) => (JSON.parse(run.err) as Schema<"Error">).error;
/** Runs with no credential at all: a profile that has none. */
const anonymous = (...argv: string[]) => server.cli([...argv, "--profile", "nobody"]);

describe("rulesets", () => {
  it("prints each Ruleset resource as the server's body in JSON, and readably otherwise", async () => {
    const list = json("RulesetList", await cli("rulesets", "list", "--json"));
    expect(list).toEqual(await client.request("GET", "/rulesets"));
    expect((await cli("rulesets", "list")).out).toMatch(/^Version +Tick rate +Point Budget +Map Formats\nr1 +\d+ +\d+ to \d+ +1$/);

    for (const [command, path] of [
      ["show", ""],
      ["rules", "/rules"],
      ["language", "/language"],
      ["parts", "/parts"],
      ["terrains", "/terrains"],
      ["docs", "/docs"],
    ] as const) {
      expect(body(await cli("rulesets", command, "r1", "--json"))).toEqual(await client.request("GET", `/rulesets/r1${path}`));
      const human = await anonymous("rulesets", command, "r1");
      expect(human).toMatchObject({ code: 0, err: "" });
      expect(human.out.startsWith("{")).toBe(false);
    }
    expect((await cli("rulesets", "show", "r1")).out).toMatch(/^Map Formats: +1$/m);
    expect((await cli("rulesets", "parts", "r1")).out).toMatch(/^ +scout +\S+/m);
    expect((await cli("rulesets", "language", "r1")).out).toMatch(/^ +throttle +1 +\d+ +no$/m);
    expect((await cli("rulesets", "docs", "r1")).out).toMatch(/^engine +\S+/m);
  });

  it("prints a document's Markdown as is, in both output modes", async () => {
    const markdown = (await client.send("GET", "/rulesets/r1/docs/language")).text.replace(/\n$/, "");
    expect(await cli("rulesets", "docs", "r1", "language")).toMatchObject({ code: 0, out: markdown });
    expect(await cli("rulesets", "docs", "r1", "language", "--json")).toMatchObject({ code: 0, out: markdown });
    expect(markdown.startsWith("#")).toBe(true);
  });

  it("refuses an unknown Ruleset or document", async () => {
    expect((await cli("rulesets", "show", "r99")).code).toBe(1);
    expect(errorOf(await cli("rulesets", "docs", "r1", "nope", "--json")).code).toBe("not_found");
    expect((await cli("rulesets", "show")).code).toBe(2);
  });
});

describe("designs", () => {
  async function create(...extra: string[]): Promise<Schema<"BotDesign">> {
    return json("BotDesign", await cli("designs", "create", "--name", "Hunter", "--build", at("build.json"), "--program", at("hunter.ptk"), "--json", ...extra));
  }

  it("creates a design under the latest hosted Ruleset, and shows it with its Program saved to a file", async () => {
    const human = await cli("designs", "create", "--name", "Hunter", "--build", at("build.json"), "--program", at("hunter.ptk"), "--notes", "first");
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^Created Bot Design \S+ \("Hunter"\) under Ruleset r1, 84 points\.$/);
    const design = await create("--description", "circles");
    expect(design).toMatchObject({ name: "Hunter", description: "circles", rulesetVersion: "r1", latestRevision: { number: 1, build: BUILD, program: PROGRAM } });

    const show = await cli("designs", "show", design.id);
    expect(show.out).toContain(`id:           ${design.id}`);
    expect(show.out).toContain(`Build:        ${JSON.stringify(BUILD)}`);
    expect(show.out).toContain(`Program:      3 lines, ${String(PROGRAM.length)} characters (save it with --program-out FILE)`);
    expect(show.out).not.toContain("throttle");

    const pulled = await cli("designs", "show", design.id, "--program-out", at("pulled.ptk"), "--json");
    expect(body(pulled)).toEqual(await client.request("GET", `/bot-designs/${design.id}`));
    expect(await readFile(at("pulled.ptk"), "utf8")).toBe(PROGRAM);
  });

  it("revises one half, keeping the latest Revision's other half", async () => {
    const design = await create();
    const program = "function tick() { turn(1); }";
    await writeFile(at("turner.ptk"), program);
    const revised = await cli("designs", "revise", design.id, "--program", at("turner.ptk"), "--notes", "turn instead");
    expect(revised.out).toBe(`Added Revision 2 to Bot Design ${design.id}, 84 points.`);
    const heavier = { ...BUILD, armor: { ...noArmor, front: "lightPlate" } };
    const fromStdin = await server.cli(["designs", "revise", design.id, "--build", "-", "--json"], { stdin: JSON.stringify(heavier) });
    expect(json("BotDesignRevision", fromStdin)).toMatchObject({ number: 3, build: heavier, program, notes: "" });
    expect(json("BotDesignRevision", await cli("designs", "revision", design.id, "2", "--json"))).toMatchObject({ build: BUILD, program, notes: "turn instead" });

    expect((await cli("designs", "revise", design.id)).code).toBe(2);
    const both = await server.cli(["designs", "revise", design.id, "--build", "-", "--program", "-"], { stdin: "{}" });
    expect(both.err).toContain("--build and --program cannot both read stdin");
  });

  it("lists, pages, renames, copies, deletes Revisions and archives", async () => {
    const design = await create();
    await cli("designs", "revise", design.id, "--program", at("hunter.ptk"), "--notes", "again");
    expect((await cli("designs", "list")).out).toMatch(new RegExp(`^${design.id} +Hunter +r1 +2 +84 +just now$`, "m"));
    const revisions = await cli("designs", "revisions", design.id, "--limit", "1");
    expect(revisions.out).toMatch(/^Revision +Cost +Created +Notes\n2 +84 +just now +again$/);
    expect(revisions.err).toMatch(/^More: --cursor \S+ \(or --all\)$/);
    expect(json("BotDesignRevisionList", await cli("designs", "revisions", design.id, "--limit", "1", "--all", "--json")).revisions).toHaveLength(2);

    const one = await cli("designs", "revision", design.id, "1", "--program-out", at("one.ptk"));
    expect(one.out).toContain(`written to ${at("one.ptk")}`);
    expect(await readFile(at("one.ptk"), "utf8")).toBe(PROGRAM);
    expect((await cli("designs", "revision", design.id, "one")).code).toBe(2);

    expect((await cli("designs", "update", design.id, "--name", "Stalker")).out).toBe(`Updated Bot Design ${design.id} ("Stalker").`);
    expect((await cli("designs", "update", design.id)).code).toBe(2);

    const dryRun = await cli("designs", "copy", design.id, "--ruleset", "r1", "--revision", "1", "--dry-run");
    expect(dryRun.out).toBe("Revision 1 under Ruleset r1: valid, 84 points.\nNothing was saved (--dry-run).");
    const copied = json("CopiedBotDesign", await cli("designs", "copy", design.id, "--ruleset", "r1", "--name", "Copy", "--json"));
    expect(copied.botDesign).toMatchObject({ name: "Copy", copiedFrom: { designId: design.id, revision: 2 } });
    expect((await cli("designs", "copy", design.id)).code).toBe(2);

    expect(await cli("designs", "delete-revision", design.id, "1")).toMatchObject({ code: 0, out: `Deleted Revision 1 of Bot Design ${design.id}.` });
    expect((await cli("designs", "delete-revision", design.id, "2")).code).toBe(1);
    expect(await cli("designs", "archive", design.id, "--json")).toMatchObject({ code: 0, out: "{}" });
    expect(json("BotDesignList", await cli("designs", "list", "--json")).botDesigns.map((d) => d.name)).toEqual(["Copy"]);
    const all = await cli("designs", "list", "--include-archived");
    expect(all.out).toMatch(/^\S+ +Stalker .* archived$/m);
  });

  it("shows a Program's problems at its file in human output, and at program in JSON", async () => {
    await writeFile(at("broken.ptk"), "function tick() {\n  fly();\n}\n");
    const args = ["designs", "create", "--name", "Broken", "--build", at("build.json"), "--program", at("broken.ptk")];
    const human = await cli(...args);
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toMatch(new RegExp(`^  ${at("broken.ptk").replace(/[\\.]/g, "\\$&")}:2:3: .+`, "m"));
    const error = errorOf(await cli(...args, "--json"));
    expect(error.details).toEqual([expect.objectContaining({ path: "program", line: 2, column: 3 })]);

    await writeFile(at("bad.json"), "{");
    const badBuild = await cli("designs", "create", "--name", "X", "--build", at("bad.json"), "--program", at("hunter.ptk"));
    expect(badBuild.code).toBe(1);
    expect(badBuild.err).toContain(`positrontanks: input: ${at("bad.json")} is not valid JSON`);
    expect((await cli("designs", "create", "--name", "X", "--build", at("build.json"))).code).toBe(2);
  });

  it("needs a credential", async () => {
    expect(await anonymous("designs", "list")).toMatchObject({ code: 3, out: "" });
  });

  it("points to the offline check where the server has the tick cost check off", async () => {
    const design = await create();
    const human = await cli("designs", "tick-cost", design.id);
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toContain("run it offline with 'positrontanks tick-cost --entry FILE'");
    expect(errorOf(await cli("designs", "tick-cost", design.id, "--json")).code).toBe("feature_disabled");
  });
});

describe("maps", () => {
  it("creates a Map from the file positrontanks run reads, and writes it back unchanged", async () => {
    const file = JSON.parse(await readFile(at("duel.json"), "utf8")) as unknown;
    const created = await cli("maps", "create", "--name", "Duel", "--map", at("duel.json"), "--notes", "v1");
    expect(created.out).toMatch(/^Created Map \S+ \("Duel"\), 60 x 40 m, 2 Spawn Zones\.$/);
    const map = json("MapList", await cli("maps", "list", "--json")).maps[0];
    if (map === undefined) throw new Error("no Map");

    // Map reads need no credential.
    const show = await anonymous("maps", "show", map.id, "--out", at("pulled.json"));
    expect(show).toMatchObject({ code: 0, err: "" });
    expect(show.out).toMatch(/^creator: +ada$/m);
    expect(show.out).toMatch(/^Map: +Format 1, 60 x 40 m, 2 Spawn Zones, \d+ Obstacles$/m);
    expect(JSON.parse(await readFile(at("pulled.json"), "utf8"))).toEqual(file);
    expect(body(await anonymous("maps", "show", map.id, "--json"))).toEqual(await client.request("GET", `/maps/${map.id}`));
  });

  it("lists by creator, revises, renames, deletes Revisions and archives", async () => {
    const map = json("Map", await cli("maps", "create", "--name", "Duel", "--map", at("duel.json"), "--json"));
    expect((await cli("maps", "list")).out).toMatch(new RegExp(`^${map.id} +Duel +ada +1 +60 x 40 m +2 +just now$`, "m"));
    expect(json("MapList", await cli("maps", "list", "--mine", "--json")).maps).toHaveLength(1);
    expect(json("MapList", await cli("maps", "list", "--creator", "bob", "--json")).maps).toHaveLength(0);
    expect((await cli("maps", "list", "--creator", "bob")).out).toBe("No Maps.");
    expect((await cli("maps", "list", "--creator", "bob", "--mine")).code).toBe(2);
    expect((await anonymous("maps", "list", "--mine")).code).toBe(3);

    const wider = { ...(JSON.parse(await readFile(at("duel.json"), "utf8")) as Record<string, unknown>), width: 70 };
    const revised = await server.cli(["maps", "revise", map.id, "--map", "-", "--notes", "wider"], { stdin: JSON.stringify(wider) });
    expect(revised.out).toBe(`Added Revision 2 to Map ${map.id}.`);
    expect((await cli("maps", "revise", map.id)).code).toBe(2);
    expect((await cli("maps", "revisions", map.id)).out).toMatch(/^2 +70 x 40 m +2 +just now +wider$/m);

    await cli("maps", "revision", map.id, "1", "--out", at("one.json"));
    expect(JSON.parse(await readFile(at("one.json"), "utf8"))).toEqual(JSON.parse(await readFile(at("duel.json"), "utf8")));
    expect(json("MapRevision", await cli("maps", "revision", map.id, "2", "--json")).map.width).toBe(70);

    expect((await cli("maps", "update", map.id, "--description", "Two sides")).out).toBe(`Updated Map ${map.id} ("Duel").`);
    expect(await cli("maps", "delete-revision", map.id, "1")).toMatchObject({ code: 0, out: `Deleted Revision 1 of Map ${map.id}.` });
    expect(await cli("maps", "archive", map.id)).toMatchObject({ code: 0, out: `Archived Map ${map.id}.` });
    expect(json("MapList", await cli("maps", "list", "--json")).maps).toHaveLength(0);
    expect((await cli("maps", "list", "--include-archived")).out).toMatch(/ archived$/m);
  });

  it("refuses a malformed Map with the server's details, and another Player's changes", async () => {
    await writeFile(at("tiny.json"), JSON.stringify({ format: 1 }));
    const bad = await cli("maps", "create", "--name", "Tiny", "--map", at("tiny.json"));
    expect(bad.code).toBe(1);
    expect(bad.err.split("\n")[0]).toMatch(/^positrontanks: validation_failed: /);
    expect(bad.err.split("\n").length).toBeGreaterThan(1);

    const map = json("Map", await cli("maps", "create", "--name", "Duel", "--map", at("duel.json"), "--json"));
    await server.cli(["auth", "signup", "bob", "--password-stdin"], pw);
    await server.cli(["auth", "login", "bob", "--password-stdin", "--profile", "bob"], pw);
    expect(errorOf(await cli("maps", "archive", map.id, "--profile", "bob", "--json")).code).toBe("forbidden");
  });
});

describe("tick-cost --remote", () => {
  it("answers feature_disabled where the server has the check off, pointing to the offline check", async () => {
    await writeFile(at("ada.entry.json"), JSON.stringify({ bots: [{ name: "Probe", build: BUILD, programFile: "hunter.ptk" }] }));
    const human = await cli("tick-cost", "--entry", at("ada.entry.json"), "--remote");
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toContain("'positrontanks tick-cost --entry FILE'");
    expect(errorOf(await cli("tick-cost", "--entry", at("ada.entry.json"), "--remote", "--json")).code).toBe("feature_disabled");
    expect(await anonymous("tick-cost", "--entry", at("ada.entry.json"), "--remote")).toMatchObject({ code: 3 });
  });
});

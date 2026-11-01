import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schema } from "./client.js";
import { samplePng } from "./sample-png.js";
import { startTestServer, type CliRun, type TestServer } from "./test-server.js";

const pw = { stdin: "correct horse battery\n" };
const noArmor = { front: null, left: null, right: null, rear: null };
const BUILD = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };

let server: TestServer;
let design: string;

beforeEach(async () => {
  server = await startTestServer();
  expect((await server.cli(["auth", "signup", "ada", "--password-stdin"], pw)).code).toBe(0);
  expect((await server.cli(["auth", "login", "ada", "--password-stdin"], pw)).code).toBe(0);
  const build = await file("build.json", new TextEncoder().encode(JSON.stringify(BUILD)));
  const program = await file("hunter.ptk", new TextEncoder().encode("function tick() {}\n"));
  const created = await cli("designs", "create", "--name", "Hunter", "--build", build, "--program", program, "--json");
  expect(created.code).toBe(0);
  design = (json(created) as Schema<"BotDesign">).id;
});

afterEach(async () => {
  await server.close();
});

const cli = (...argv: string[]) => server.cli(argv);
const json = (run: CliRun): unknown => JSON.parse(run.out);
const errorOf = (run: CliRun) => (JSON.parse(run.err) as Schema<"Error">).error;
const iconOf = async (id: string) => (json(await cli("designs", "show", id, "--json")) as Schema<"BotDesign">).icon;

async function file(name: string, content: Uint8Array): Promise<string> {
  const path = join(server.configFile, "..", name);
  await writeFile(path, content);
  return path;
}

describe("designs icon", () => {
  it("sets, replaces and clears the Icon, in JSON output, adding no Revision", async () => {
    const set = await cli("designs", "icon", "set", design, await file("a.png", samplePng(64)), "--json");
    expect(set).toMatchObject({ code: 0, err: "" });
    const updated = json(set) as Schema<"BotDesign">;
    expect(updated.id).toBe(design);
    expect(updated.icon).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.latestRevision.number).toBe(1);
    expect(await iconOf(design)).toBe(updated.icon);

    const replaced = json(await cli("designs", "icon", "set", design, await file("b.png", samplePng(32)), "--json")) as Schema<"BotDesign">;
    expect(replaced.icon).not.toBe(updated.icon);

    const clear = await cli("designs", "icon", "clear", design, "--json");
    expect(clear).toMatchObject({ code: 0, err: "" });
    expect(json(clear)).toEqual({});
    expect(await iconOf(design)).toBeNull();
  });

  it("prints what it did in human output, and shows the Icon", async () => {
    expect((await cli("designs", "show", design)).out).toMatch(/^Icon: +none$/m);
    const set = await cli("designs", "icon", "set", design, await file("a.png", samplePng(64)));
    expect(set.code).toBe(0);
    expect(set.out).toMatch(new RegExp(`^Set the Icon of Bot Design ${design} \\("Hunter"\\) \\(Icon [0-9a-f]{64}\\)\\.$`));
    expect((await cli("designs", "show", design)).out).toMatch(/^Icon: +[0-9a-f]{64}$/m);

    const removed = `Removed the Icon of Bot Design ${design}.`;
    expect(await cli("designs", "icon", "clear", design)).toMatchObject({ code: 0, out: removed, err: "" });
    // Clearing an Icon that is not there is not an error.
    expect(await cli("designs", "icon", "clear", design)).toMatchObject({ code: 0, out: removed });
  });

  it("changes an archived design too", async () => {
    expect((await cli("designs", "archive", design)).code).toBe(0);
    expect((await cli("designs", "icon", "set", design, await file("a.png", samplePng(64)))).code).toBe(0);
    expect(await iconOf(design)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a file the server rejects, in both output modes", async () => {
    const path = await file("wide.png", samplePng(64, 32));
    const human = await cli("designs", "icon", "set", design, path);
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toMatch(/^positrontanks: validation_failed: /);
    expect(human.err).toContain("(body): ");

    const machine = await cli("designs", "icon", "set", design, path, "--json");
    expect(machine).toMatchObject({ code: 1, out: "" });
    expect(errorOf(machine).code).toBe("validation_failed");
    expect(await iconOf(design)).toBeNull();
  });

  it("refuses a design that is not yours, a missing file, missing arguments and a missing key", async () => {
    const png = await file("a.png", samplePng(64));
    const unknown = await cli("designs", "icon", "set", "no-such-design", png, "--json");
    expect(unknown).toMatchObject({ code: 1, out: "" });
    expect(errorOf(unknown).code).toBe("not_found");
    expect((await cli("designs", "icon", "clear", "no-such-design")).code).toBe(1);

    const missing = await cli("designs", "icon", "set", design, "no-such.png");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^positrontanks: input: cannot read no-such\.png/);

    expect((await cli("designs", "icon", "set", design)).code).toBe(2);
    expect((await cli("designs", "icon", "clear")).code).toBe(2);
    expect((await cli("designs", "icon")).code).toBe(2);

    expect((await cli("auth", "logout")).code).toBe(0);
    expect((await cli("designs", "icon", "clear", design)).code).toBe(3);
  });
});

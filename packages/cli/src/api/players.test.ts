import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schema } from "./client.js";
import { samplePng } from "./sample-png.js";
import { startTestServer, type CliRun, type TestServer } from "./test-server.js";

const pw = { stdin: "correct horse battery\n" };

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
  expect((await server.cli(["auth", "signup", "ada", "--password-stdin"], pw)).code).toBe(0);
  expect((await server.cli(["auth", "login", "ada", "--password-stdin"], pw)).code).toBe(0);
});

afterEach(async () => {
  await server.close();
});

const cli = (...argv: string[]) => server.cli(argv);
const json = (run: CliRun): unknown => JSON.parse(run.out);
const errorOf = (run: CliRun) => (JSON.parse(run.err) as Schema<"Error">).error;

async function file(name: string, content: Uint8Array): Promise<string> {
  const path = join(server.configFile, "..", name);
  await writeFile(path, content);
  return path;
}

describe("players emblem", () => {
  it("sets, replaces and clears the Emblem, in JSON output", async () => {
    const set = await cli("players", "emblem", "set", await file("a.png", samplePng(64)), "--json");
    expect(set).toMatchObject({ code: 0, err: "" });
    const player = json(set) as Schema<"Player">;
    expect(player.username).toBe("ada");
    expect(player.emblem).toMatch(/^[0-9a-f]{64}$/);
    expect((json(await cli("auth", "whoami", "--json")) as Schema<"Player">).emblem).toBe(player.emblem);

    const replaced = json(await cli("players", "emblem", "set", await file("b.png", samplePng(32)), "--json")) as Schema<"Player">;
    expect(replaced.emblem).not.toBe(player.emblem);

    const clear = await cli("players", "emblem", "clear", "--json");
    expect(clear).toMatchObject({ code: 0, err: "" });
    expect(json(clear)).toEqual({});
    expect((json(await cli("auth", "whoami", "--json")) as Schema<"Player">).emblem).toBeNull();
  });

  it("prints what it did in human output", async () => {
    const set = await cli("players", "emblem", "set", await file("a.png", samplePng(64)));
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/^Set the Emblem of ada \(Emblem [0-9a-f]{64}\)\.$/);
    expect(await cli("players", "emblem", "clear")).toMatchObject({ code: 0, out: "Removed your Emblem.", err: "" });
    // Clearing an Emblem that is not there is not an error.
    expect(await cli("players", "emblem", "clear")).toMatchObject({ code: 0, out: "Removed your Emblem." });
  });

  it("reports a file the server rejects, in both output modes", async () => {
    const path = await file("wide.png", samplePng(64, 32));
    const human = await cli("players", "emblem", "set", path);
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toMatch(/^positrontanks: validation_failed: /);
    expect(human.err).toContain("(body): ");

    const machine = await cli("players", "emblem", "set", path, "--json");
    expect(machine).toMatchObject({ code: 1, out: "" });
    expect(errorOf(machine).code).toBe("validation_failed");
    expect((json(await cli("auth", "whoami", "--json")) as Schema<"Player">).emblem).toBeNull();
  });

  it("refuses a missing file, a missing argument and a missing key", async () => {
    const missing = await cli("players", "emblem", "set", "no-such.png");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^positrontanks: input: cannot read no-such\.png/);

    expect((await cli("players", "emblem", "set")).code).toBe(2);
    expect((await cli("players", "emblem")).code).toBe(2);

    expect((await cli("auth", "logout")).code).toBe(0);
    expect((await cli("players", "emblem", "clear")).code).toBe(3);
  });
});

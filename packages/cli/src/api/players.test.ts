import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Schema } from "./client.js";
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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A valid all-transparent RGBA PNG, `width` by `height` pixels. */
function samplePng(width: number, height = width): Uint8Array {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array(height * (1 + width * 4)))),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

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

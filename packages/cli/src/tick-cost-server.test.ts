import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./api/client.js";
import { startTestServer, type TestServer } from "./api/test-server.js";
import { main } from "./cli.js";

const noArmor = { front: null, left: null, right: null, rear: null };
/** Scout + pellet gun + radar + wheels = 84 points; the minimal Processor's 1,000 operations per Tick. */
const BUILD = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };
/** 6 operations every Tick: each built-in call costs 2, plus 1 for its literal argument. */
const STEADY = "function tick() { throttle(1); turn(0.5); }";

let server: TestServer;
let client: ApiClient;

beforeEach(async () => {
  server = await startTestServer({ tickCostCheck: true });
  const password = { stdin: "correct horse battery" };
  await server.cli(["auth", "signup", "ada", "--password-stdin"], password);
  await server.cli(["auth", "login", "ada", "--password-stdin"], password);
  client = new ApiClient(server.url, (await server.config())?.profiles.default?.apiKey);
});

afterEach(async () => {
  await server.close();
});

/** `positrontanks tick-cost --json` for one Bot with the Build and Program, and the report it prints. */
async function cliReport(program: string, ...options: string[]): Promise<unknown> {
  const entry = join(server.configFile, "..", "ada.entry.json");
  await writeFile(entry, JSON.stringify({ ruleset: "r1", bots: [{ name: "Probe", build: BUILD, program }] }));
  const out: string[] = [];
  const code = await main(["tick-cost", "--entry", entry, "--json", ...options], { out: (l) => out.push(l), err: (l) => out.push(l) });
  expect(code).toBe(0);
  const [bot] = (JSON.parse(out.join("\n")) as { bots: { report: unknown }[] }).bots;
  return bot?.report;
}

const serverReport = (program: string, options: { ticks?: number; seed?: number } = {}) =>
  client.request("POST", "/tick-cost-checks", { auth: true, body: { rulesetVersion: "r1", build: BUILD, program, ...options } });

describe("positrontanks tick-cost and the server's tick cost check", () => {
  it("report the same numbers, with the same defaults", async () => {
    expect(await cliReport(STEADY)).toEqual(await serverReport(STEADY));
    const program = "let seen = []; function tick() { if (random() < 0.5) { seen.push(scan().length); } while (random() < 0.9) {} }";
    expect(await cliReport(program, "--ticks", "37", "--seed", "4242")).toEqual(await serverReport(program, { ticks: 37, seed: 4242 }));
  });

  it("run on the server with --remote, with the offline command's input and output", async () => {
    const entry = join(server.configFile, "..", "ada.entry.json");
    await writeFile(join(entry, "..", "steady.ptk"), STEADY);
    await writeFile(entry, JSON.stringify({ bots: [{ name: "Probe", build: BUILD, programFile: "steady.ptk" }, { name: "Other", build: BUILD, program: STEADY }] }));
    const offline = await server.cli(["tick-cost", "--entry", entry, "--ticks", "5", "--json"]);
    const remote = await server.cli(["tick-cost", "--entry", entry, "--ticks", "5", "--remote", "--json"]);
    expect(remote).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(remote.out)).toEqual(JSON.parse(offline.out));

    const human = await server.cli(["tick-cost", "--entry", entry, "--remote"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`Ruleset r1, Entry ${entry} (ada), seed 1, 20 Ticks in the sample world on ${server.url}`);
    expect(human.out).toMatch(/^ +Probe +\d+\/\d+/m);

    await writeFile(join(entry, "..", "steady.ptk"), "function tick() {\n  fly();\n}");
    const broken = await server.cli(["tick-cost", "--entry", entry, "--remote"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('Bot "Probe": ');
    expect(broken.err).toContain(`${join(entry, "..", "steady.ptk")}:2:3: `);
  });

  it("check a Bot Design's Revision with designs tick-cost", async () => {
    const design = await client.request<{ id: string }>("POST", "/bot-designs", { auth: true, body: { name: "Steady", rulesetVersion: "r1", build: BUILD, program: STEADY } });
    const run = await server.cli(["designs", "tick-cost", design.id, "--ticks", "7", "--seed", "0", "--json"]);
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(run.out)).toEqual(await serverReport(STEADY, { ticks: 7, seed: 0 }));
    const human = await server.cli(["designs", "tick-cost", design.id, "--revision", "1"]);
    expect(human.out).toContain(`Bot Design ${design.id} (Revision 1), seed 1, 20 Ticks`);
    expect(human.out).toContain("Tick cost (operations per Tick):");
  });
});

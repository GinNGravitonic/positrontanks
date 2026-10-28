import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../cli.js";
import { ApiClient, type Schema } from "./client.js";
import { parseBot, RECONNECT_BACKOFF_MS, WAIT_POLL_MS } from "./games.js";
import type { components } from "./schema.js";
import { startTestServer, type CliRun, type TestServer } from "./test-server.js";

const duelMap = fileURLToPath(new URL("../../../ruleset-data/maps/duel.json", import.meta.url));
const pw = { stdin: "correct horse battery\n" };
const noArmor = { front: null, left: null, right: null, rear: null };
const BUILD = { chassis: "scout", components: { gun: "pelletGun", eye: "radar", drive: "wheels" }, armor: noArmor };
/** Charges forward firing straight ahead, and logs each Tick. */
const PROGRAM = 'function tick() {\n  throttle(1);\n  fire("gun", 0);\n  log(self.tick);\n}\n';

/** The Game runner's pacing: a Tick per turn of the event loop, or held at the next Tick until released. */
let release: (() => void) | undefined;
let held: Promise<void> | undefined;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function hold(): void {
  held = new Promise((resolve) => (release = resolve));
}

let server: TestServer;
let dir: string;
let client: ApiClient;
let mapId: string;
let adaDesign: string;
let bobDesign: string;

beforeEach(async () => {
  held = undefined;
  server = await startTestServer({
    pacing: {
      sleep: async () => {
        if (held !== undefined) await held;
        await nextTurn();
      },
    },
  });
  dir = await mkdtemp(join(tmpdir(), "aumohta-cli-games-"));
  await writeFile(at("build.json"), JSON.stringify(BUILD));
  await writeFile(at("hunter.aum"), PROGRAM);
  await copyFile(duelMap, at("duel.json"));
  for (const player of ["ada", "bob"]) {
    expect((await server.cli(["auth", "signup", player, "--password-stdin"], pw)).code).toBe(0);
    expect((await server.cli(["auth", "login", player, "--password-stdin", "--profile", player], pw)).code).toBe(0);
  }
  client = new ApiClient(server.url, (await server.config())?.profiles.ada?.apiKey);
  mapId = json("Map", await ada("maps", "create", "--name", "Duel", "--map", at("duel.json"), "--json")).id;
  const design = async (as: typeof ada) =>
    json("BotDesign", await as("designs", "create", "--name", "Hunter", "--build", at("build.json"), "--program", at("hunter.aum"), "--json")).id;
  adaDesign = await design(ada);
  bobDesign = await design(bob);
});

afterEach(async () => {
  release?.();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const at = (file: string) => join(dir, file);
const ada = (...argv: string[]) => server.cli([...argv, "--profile", "ada"]);
const bob = (...argv: string[]) => server.cli([...argv, "--profile", "bob"]);
/** The JSON a successful run printed. */
const body = (run: CliRun): unknown => {
  expect(run).toMatchObject({ code: 0, err: "" });
  return JSON.parse(run.out);
};
const json = <Name extends keyof components["schemas"]>(name: Name, run: CliRun) => body(run) as Schema<Name>;
const errorOf = (run: CliRun) => (JSON.parse(run.err) as Schema<"Error">).error;

/** A 2-Player Game on the Duel Map, 2 s long. */
async function createGame(...extra: string[]): Promise<Schema<"Game">> {
  return json("Game", await ada("games", "create", "--map", mapId, "--time-limit", "2", "--json", ...extra));
}

/** Plays a Game to the end: both Players enter, then it runs. */
async function playGame(): Promise<string> {
  const game = await createGame();
  expect((await ada("games", "enter", game.id, "--bot", `Ada=${adaDesign}`)).code).toBe(0);
  expect((await bob("games", "enter", game.id, "--bot", `Bob=${bobDesign}`)).code).toBe(0);
  for (;;) {
    const { state } = await client.request<Schema<"Game">>("GET", `/games/${game.id}`);
    if (state === "finished") return game.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("games create, browse, show and cancel", () => {
  it("creates a Game with the defaults of 'aumohta run'", async () => {
    const human = await ada("games", "create", "--map", mapId);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^Created Game \S+ on Duel \(Revision 1\): 2 Players, Point Budget \d+, 120 s, real time; fills by .+\.$/m);

    const game = await createGame("--unthrottled", "--players", "2", "--fill-timeout", "60");
    const { pointBudget } = await client.request<Schema<"RulesetSummary">>("GET", "/rulesets/r1");
    expect(game).toMatchObject({
      state: "open",
      rulesetVersion: "r1",
      map: { id: mapId, revision: 1 },
      playerCount: 2,
      pointBudget: pointBudget.max,
      timeLimitSeconds: 2,
      pace: "unthrottled",
      fillTimeoutSeconds: 60,
    });
    expect(json("Game", await ada("games", "create", "--map", mapId, "--json"))).toMatchObject({ timeLimitSeconds: 120, pace: "realtime", fillTimeoutSeconds: 3600 });
    expect(body(await ada("games", "show", game.id, "--json"))).toEqual(await client.request("GET", `/games/${game.id}`));
    expect((await ada("games", "show", game.id)).out).toMatch(/^state: +open$/m);
  });

  it("refuses bad options before sending, and needs a credential", async () => {
    expect((await ada("games", "create")).code).toBe(2);
    expect((await ada("games", "create", "--map", mapId, "--players", "1")).code).toBe(2);
    const anonymous = await server.cli(["games", "create", "--map", mapId, "--profile", "nobody", "--json"]);
    expect(anonymous.code).toBe(3);
    expect(errorOf(anonymous).code).toBe("not_authenticated");
    expect(errorOf(await ada("games", "create", "--map", mapId, "--point-budget", "1", "--json")).code).toBe("validation_failed");
  });

  it("browses Open Games with filters", async () => {
    const game = await createGame();
    const list = json("GameList", await bob("games", "browse", "--json"));
    expect(list.games.map((g) => g.id)).toEqual([game.id]);
    expect(json("GameList", await bob("games", "browse", "--players", "3", "--json")).games).toEqual([]);
    expect(json("GameList", await bob("games", "browse", "--map", mapId, "--ruleset", "r1", "--min-budget", "1", "--json")).games).toHaveLength(1);
    expect((await bob("games", "browse")).out).toMatch(new RegExp(`^${game.id} +r1 +Duel \\(Revision 1\\) +0/2 +\\d+ +2 s, real time +ada +`, "m"));
    expect((await bob("games", "browse", "--players", "3")).out).toBe("No Games.");
  });

  it("cancels an Open Game", async () => {
    const game = await createGame();
    expect((await bob("games", "cancel", game.id)).code).toBe(1);
    expect(await ada("games", "cancel", game.id)).toMatchObject({ code: 0, out: `Cancelled Game ${game.id}.` });
    expect(json("Game", await ada("games", "show", game.id, "--json"))).toMatchObject({ state: "cancelled", cancelReason: "initiator" });
    expect(errorOf(await ada("games", "snapshot", game.id, "--json")).code).toBe("game_cancelled");
    expect((await ada("games", "watch", game.id)).code).toBe(1);
    expect((await ada("games", "mine", "--state", "cancelled")).out).toMatch(new RegExp(`^${game.id} +cancelled +r1 .+cancelled \\(initiator\\)$`, "m"));
  });
});

describe("games enter, withdraw and mine", () => {
  it("parses --bot NAME=DESIGN_ID[@REV]", () => {
    expect(parseBot("Hunter=abc")).toEqual({ name: "Hunter", designId: "abc" });
    expect(parseBot("Hunter=abc@2")).toEqual({ name: "Hunter", designId: "abc", revision: 2 });
    expect(parseBot("Hunter=a=b@3")).toEqual({ name: "Hunter", designId: "a=b", revision: 3 });
    for (const bad of ["Hunter", "=abc", "Hunter=", "Hunter=@2", "Hunter=abc@x"]) expect(() => parseBot(bad)).toThrow(/--bot/);
  });

  it("enters with --bot or --entry-json, and withdraws", async () => {
    const game = await createGame();
    expect((await ada("games", "enter", game.id)).code).toBe(2);
    expect((await ada("games", "enter", game.id, "--bot", "Hunter", "--json")).code).toBe(2);

    const human = await ada("games", "enter", game.id, "--bot", `Hunter=${adaDesign}@1`, "--bot", `Second=${adaDesign}`);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^Entered Game \S+ with Entry \S+: Hunter, Second, \d+ points\.\nWaiting for 1 more of 2 Entries\.$/);
    const shown = json("Game", await ada("games", "show", game.id, "--json"));
    const [entry] = shown.entries;
    expect(entry?.bots).toMatchObject([{ name: "Hunter", design: { designId: adaDesign, revision: 1 } }, { name: "Second" }]);
    expect((await ada("games", "show", game.id)).out).toContain(`Hunter (${adaDesign}@1), Second (${adaDesign}@1)`);
    expect(json("GameList", await ada("games", "mine", "--state", "open", "--json")).games.map((g) => g.id)).toContain(game.id);

    expect(await ada("games", "withdraw", game.id, entry?.id ?? "")).toMatchObject({ code: 0, out: `Withdrew Entry ${entry?.id ?? ""} from Game ${game.id}.` });
    expect(json("Game", await ada("games", "show", game.id, "--json")).entryCount).toBe(0);

    await writeFile(at("entry.json"), JSON.stringify({ bots: [{ designId: adaDesign, name: "Odd=Name" }] }));
    const submitted = json("SubmittedGameEntry", await ada("games", "enter", game.id, "--entry-json", at("entry.json"), "--json"));
    expect(submitted.entry.bots[0]?.name).toBe("Odd=Name");
    expect(submitted.game.entryCount).toBe(1);
    expect(errorOf(await bob("games", "enter", game.id, "--bot", `Hunter=${adaDesign}`, "--json")).code).toBe("validation_failed");
  });
});

describe("spectating", () => {
  it("shows the snapshot, Replay and Program logs of a Finished Game", async () => {
    const id = await playGame();
    const snapshot = json("GameSnapshot", await ada("games", "snapshot", id, "--json"));
    expect(snapshot).toEqual(await client.request("GET", `/games/${id}/snapshot`));
    const human = (await bob("games", "snapshot", id)).out;
    expect(human).toMatch(/^Tick \d+ of \d+ /m);
    expect(human).toMatch(/^ +1 +Ada +ada +\S+ +\w+ +/m);
    expect(human).toMatch(/^Result: /m);

    const replay = json("GameReplay", await ada("games", "replay", id, "--json"));
    expect(replay).toEqual(await client.request("GET", `/games/${id}/replay`));
    expect(await ada("games", "replay", id)).toMatchObject({ code: 0, out: JSON.stringify(replay.replay) });
    const written = await ada("games", "replay", id, "--out", at("replay.json"));
    expect(written.out).toBe(`Wrote the Replay of Game ${id} (${String(replay.replay.ticks.length)} Ticks) to ${at("replay.json")}.`);
    expect(await readFile(at("replay.json"), "utf8")).toBe(`${JSON.stringify(replay.replay)}\n`);

    const logs = json("ProgramLogs", await ada("games", "logs", id, "--from-tick", "1", "--to-tick", "3", "--json"));
    expect(logs.bots.map((b) => b.name)).toEqual(["Ada"]);
    expect(logs.bots[0]?.runs.map((r) => r.tick)).toEqual([1, 2, 3]);
    expect(logs.bots[0]?.runs[1]?.result.log).toEqual(["2"]);
    expect((await ada("games", "logs", id, "--out", at("logs.json"))).out).toMatch(/^Wrote \d+ Program runs of 1 Bots in Game /);
    expect(JSON.parse(await readFile(at("logs.json"), "utf8"))).toEqual(await client.request("GET", `/games/${id}/program-logs`));
    expect((await ada("games", "logs", id, "--from-tick", "3", "--to-tick", "1")).code).toBe(2);
  });

  it("refuses to watch a Game that has not started, unless told to wait", async () => {
    const game = await createGame();
    const refused = await ada("games", "watch", game.id, "--json");
    expect(refused.code).toBe(1);
    expect(errorOf(refused).code).toBe("game_not_started");
    expect(errorOf(await ada("games", "snapshot", game.id, "--json")).code).toBe("game_not_started");
  });

  it("watches a Game from the start with --wait, and writes the Replay assembled from the stream", async () => {
    const game = await createGame();
    expect((await ada("games", "enter", game.id, "--bot", `Ada=${adaDesign}`)).code).toBe(0);
    hold();
    const polls: number[] = [];
    let entered = false;
    const watched = server.cli(["games", "watch", game.id, "--wait", "--out", at("watched.json"), "--json", "--profile", "bob"], {
      sleep: async (ms) => {
        polls.push(ms);
        if (!entered) {
          entered = true;
          expect((await server.cli(["games", "enter", game.id, "--bot", `Bob=${bobDesign}`, "--profile", "bob"])).code).toBe(0);
        }
      },
      onOut: (line) => {
        if (line.includes('"event":"snapshot"')) release?.();
      },
    });
    const run = await watched;
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(polls).toEqual([WAIT_POLL_MS]);
    const events = run.out.split("\n").map((line) => JSON.parse(line) as { event: string; id: string | null; data: unknown });
    expect(events[0]?.event).toBe("snapshot");
    expect(events[events.length - 1]?.event).toBe("end");
    expect(events.slice(1, -1).every((e) => e.event === "tick")).toBe(true);

    const { replay } = await client.request<Schema<"GameReplay">>("GET", `/games/${game.id}/replay`);
    expect(JSON.parse(await readFile(at("watched.json"), "utf8"))).toEqual(replay);
  });

  it("prints Disabled announcements and the result in human output", async () => {
    const id = await playGame();
    const run = await bob("games", "watch", id);
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.out).toMatch(new RegExp(`^Watching Game ${id}: Ruleset r1, Duel \\(Revision 1\\), ada \\(Ada\\) vs bob \\(Bob\\)$`, "m"));
    expect(run.out).toMatch(/^Result: (Draw|\w+ wins)/m);
    expect(run.out).toMatch(/^ +Player +Foe damage +Hit Points +Standing$/m);
  });
});

/**
 * A stand-in server whose stream closes before the Game ends: each
 * connection plays the next script in `connections`.
 */
describe("games watch reconnecting", () => {
  type Script = (response: ServerResponse) => void;
  let fake: Server;
  let url: string;
  let connections: Script[];
  let lastEventIds: (string | undefined)[];

  const GAME = {
    id: "g1",
    state: "running",
    initiator: { id: "p1", username: "ada" },
    rulesetVersion: "r1",
    map: { id: "m1", name: "Duel", revision: 1 },
    playerCount: 2,
    pointBudget: 100,
    timeLimitSeconds: 1,
    pace: "realtime",
    fillTimeoutSeconds: 60,
    createdAt: "2026-01-01T00:00:00Z",
    fillDeadline: "2026-01-01T01:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    endedAt: null,
    cancelReason: null,
    entryCount: 2,
    result: null,
    entries: [
      { id: "e1", player: { id: "p1", username: "ada" }, createdAt: "2026-01-01T00:00:00Z", bots: [{ name: "Ada" }] },
      { id: "e2", player: { id: "p2", username: "bob" }, createdAt: "2026-01-01T00:00:00Z", bots: [{ name: "Bob" }] },
    ],
  };
  const frame = (tick: number, events: unknown[] = []) => ({ tick, events, bots: [], projectiles: [] });
  const header = (result: unknown) => ({
    ruleset: "r1",
    tickRate: 10,
    map: {},
    timeLimitTicks: 10,
    entries: [
      { player: "p1", bots: [{ id: 1, name: "Ada", build: {} }] },
      { player: "p2", bots: [{ id: 2, name: "Bob", build: {} }] },
    ],
    result,
  });
  const RESULT = { tick: 4, end: "lastStanding", winner: "p1", decidedBy: "survival", standings: [{ player: "p1", foeDamage: 30, hitPoints: 5, remaining: true }] };
  const send = (response: ServerResponse, event: string, data: unknown, id?: number) =>
    response.write(`event: ${event}\n${id === undefined ? "" : `id: ${String(id)}\n`}data: ${JSON.stringify(data)}\n\n`);
  const snapshot = (tick: number) => ({ game: GAME, replay: { ...header(null), ticks: [frame(tick)] } });
  const ended = { game: { ...GAME, state: "finished" } };

  beforeEach(async () => {
    lastEventIds = [];
    fake = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.url === "/games/g1/snapshot") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ game: ended.game, replay: { ...header(RESULT), ticks: [frame(4)] } }));
        return;
      }
      lastEventIds.push(request.headers["last-event-id"] as string | undefined);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": heartbeat\n\n");
      const script = connections.shift();
      if (script === undefined) response.end();
      else script(response);
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => fake.close(resolve));
  });

  async function watch(...extra: string[]): Promise<CliRun & { delays: number[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const delays: number[] = [];
    const env = { APPDATA: join(dir, "none"), XDG_CONFIG_HOME: join(dir, "none"), AUMOHTA_SERVER: url, AUMOHTA_API_KEY: "test-key" };
    const io = {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      env,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    };
    const code = await main(["games", "watch", "g1", ...extra], io);
    return { code, out: out.join("\n"), err: err.join("\n"), delays };
  }

  it("reconnects with backoff after the stream closes, resetting the count when events arrive", async () => {
    connections = [
      (r) => {
        send(r, "snapshot", snapshot(0), 0);
        send(r, "tick", frame(1), 1);
        r.end();
      },
      (r) => r.end(),
      (r) => {
        send(r, "snapshot", snapshot(3), 3);
        send(r, "tick", frame(4, [{ type: "disabled", tick: 4, bot: 2, cause: "ram" }]), 4);
        send(r, "end", ended);
        r.end();
      },
    ];
    const run = await watch("--json", "--out", at("assembled.json"));
    expect(run).toMatchObject({ code: 0, err: "" });
    expect(run.delays).toEqual([1000, 2000]);
    expect(lastEventIds).toEqual([undefined, "1", "1"]);
    const events = run.out.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual(["snapshot", "tick", "reconnect", "reconnect", "snapshot", "tick", "end"]);
    expect(events[1]).toEqual({ event: "tick", id: "1", data: frame(1) });
    expect(events[2]).toEqual({ event: "reconnect", attempt: 1 });
    expect(events[3]).toEqual({ event: "reconnect", attempt: 2 });
    expect(events[6]).toEqual({ event: "end", id: null, data: ended });

    const assembled = JSON.parse(await readFile(at("assembled.json"), "utf8")) as Schema<"Replay">;
    expect(assembled.ticks.map((t) => t.tick)).toEqual([0, 1, 3, 4]);
    expect(assembled.result).toEqual(RESULT);
  });

  it("announces Disabled Bots, missed Ticks and the result in human output", async () => {
    connections = [
      (r) => {
        send(r, "snapshot", snapshot(0), 0);
        r.end();
      },
      (r) => {
        send(r, "snapshot", snapshot(3), 3);
        send(r, "tick", frame(4, [{ type: "disabled", tick: 4, bot: 2, cause: "ram" }]), 4);
        send(r, "end", ended);
        r.end();
      },
    ];
    const run = await watch();
    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        "Watching Game g1: Ruleset r1, Duel (Revision 1), ada (Ada) vs bob (Bob)",
        "Time limit 1 s (10 Ticks), real time",
        "Tick 4: Bob Disabled (ram)",
        "",
        "Result: ada wins by survival (last standing) in Tick 4 (0.4 s)",
        "  Player  Foe damage  Hit Points  Standing",
        "  ada     30          5           yes",
      ].join("\n"),
    );
    expect(run.err).toBe(["The stream closed; reconnecting in 1 s (attempt 1 of 5).", "Missed Tick 1 to 2 while reconnecting; the Replay assembled lacks it."].join("\n"));
  });

  it("gives up after 5 reconnects in a row without an event", async () => {
    connections = [
      (r) => {
        send(r, "snapshot", snapshot(0), 0);
        r.end();
      },
    ];
    const run = await watch("--json");
    expect(run.code).toBe(4);
    expect(run.delays).toEqual(RECONNECT_BACKOFF_MS);
    expect((JSON.parse(run.err) as Schema<"Error">).error.code).toBe("network");
  });
});

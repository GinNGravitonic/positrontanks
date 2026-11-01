import { replayGame, replayOf, type GameRecord, type Replay } from "@positrontanks/engine-r1";
import duelLastStanding from "@positrontanks/engine-r1/golden/duel-last-standing.json";
import { loadRuleset } from "@positrontanks/ruleset-data/rulesets";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api/client.js";
import { followGame, liveTime, LiveReplay, readEvents, RECONNECT_BACKOFF_MS, WAIT_POLL_MS, waitWhileRunning, type GameSnapshot, type StreamHandlers } from "./live.js";
import { createServices, signUp } from "./services.js";
import { fakeApi, memoryHistory, memoryStorage, sseEvent, testGame, type StreamOpening } from "./test-platform.js";
import { r1Viewer } from "./viewer/r1.js";

const golden = JSON.parse(JSON.stringify(replayOf(replayGame(duelLastStanding.record as unknown as GameRecord, loadRuleset("r1"))))) as Replay;
const running = testGame({ state: "running", startedAt: "2026-10-31T00:10:00.000Z" });
const finished = { ...running, state: "finished" as const, endedAt: "2026-10-31T00:12:00.000Z" };

/** A snapshot of the golden Game at Tick `tick`. */
const snapshot = (tick: number): GameSnapshot =>
  ({ game: running, replay: { ...golden, ticks: [golden.ticks[tick]], result: null } }) as unknown as GameSnapshot;
const tickEvent = (tick: number) => sseEvent("tick", golden.ticks[tick], tick);

async function signedIn(streams: Readonly<Record<string, readonly StreamOpening[]>>, games = [running]) {
  const api = fakeApi({ games, streams });
  const services = createServices({ fetch: api.fetch, storage: memoryStorage(), history: memoryHistory("/play/") });
  await signUp(services, { username: "ada_bot", password: "correct horse" }, null);
  return { fake: api, api: services.api };
}

/** What the handlers saw, and every wait. */
function recorder() {
  const seen: string[] = [];
  const waits: number[] = [];
  const handlers: StreamHandlers = {
    onSnapshot: (s) => seen.push(`snapshot ${String((s.replay.ticks[0] as { tick: number }).tick)}`),
    onTick: (t) => seen.push(`tick ${String((t as { tick: number }).tick)}`),
    onReconnecting: (ms) => seen.push(`reconnecting ${String(ms)}`),
  };
  const sleep = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { seen, waits, handlers, sleep };
}

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function events(stream: ReadableStream<Uint8Array>) {
  const all = [];
  for await (const event of readEvents(stream)) all.push(event);
  return all;
}

describe("reading an event stream", () => {
  it("splits it into events with their names, ids and data, however it is chunked", async () => {
    expect(await events(body("event: snap", "shot\r\ndata: {\"a\"", ":1}\r\n\r\nid: 7\nevent: tick\ndata: 1\ndata: 2\n\n"))).toEqual([
      { event: "snapshot", data: '{"a":1}' },
      { event: "tick", id: "7", data: "1\n2" },
    ]);
  });

  it("skips the server's heartbeat comments, and an event with no data", async () => {
    expect(await events(body(": heartbeat\n\nevent: nothing\n\ndata: x\n\n"))).toEqual([{ event: "message", data: "x" }]);
  });
});

describe("following a live Game", () => {
  it("passes on the snapshot and each Tick, and returns the Game when it ends", async () => {
    const { api } = await signedIn({ g1: [sseEvent("snapshot", snapshot(5)) + tickEvent(6) + tickEvent(7) + sseEvent("end", { game: finished })] });
    const { seen, handlers, sleep } = recorder();
    const ended = await followGame(api, "g1", handlers, { signal: new AbortController().signal, sleep });
    expect(ended).toEqual(finished);
    expect(seen).toEqual(["snapshot 5", "tick 6", "tick 7"]);
  });

  it("reopens a stream that closes without end, for a fresh snapshot", async () => {
    const { api, fake } = await signedIn({
      g1: [sseEvent("snapshot", snapshot(5)) + tickEvent(6), sseEvent("snapshot", snapshot(9)) + sseEvent("end", { game: finished })],
    });
    const { seen, handlers, sleep } = recorder();
    await followGame(api, "g1", handlers, { signal: new AbortController().signal, sleep });
    expect(seen).toEqual(["snapshot 5", "tick 6", `reconnecting ${String(RECONNECT_BACKOFF_MS[0])}`, "snapshot 9"]);
    expect(fake.requests.filter((r) => r === "GET /games/g1/stream")).toHaveLength(2);
  });

  it("waits longer each time in a row the server cannot be reached, and starts again after an event", async () => {
    const { api } = await signedIn({
      g1: [null, null, null, sseEvent("snapshot", snapshot(5)), null, sseEvent("end", { game: finished })],
    });
    const { waits, handlers, sleep } = recorder();
    await followGame(api, "g1", handlers, { signal: new AbortController().signal, sleep });
    expect(waits).toEqual([1000, 2000, 4000, 1000, 2000]);
  });

  it("keeps waiting the longest backoff once it runs out", async () => {
    const failures: StreamOpening[] = Array.from({ length: RECONNECT_BACKOFF_MS.length + 2 }, () => null);
    const { api } = await signedIn({ g1: [...failures, sseEvent("end", { game: finished })] });
    const { waits, handlers, sleep } = recorder();
    await followGame(api, "g1", handlers, { signal: new AbortController().signal, sleep });
    expect(waits.slice(-3)).toEqual([16_000, 16_000, 16_000]);
  });

  it("gives up on a Game that cannot be watched", async () => {
    const { api } = await signedIn({}, [testGame()]);
    const { handlers, sleep } = recorder();
    await expect(followGame(api, "g1", handlers, { signal: new AbortController().signal, sleep })).rejects.toMatchObject({ code: "game_not_started" });
  });

  it("stops when aborted", async () => {
    const { api } = await signedIn({ g1: [sseEvent("snapshot", snapshot(5))] });
    const controller = new AbortController();
    const { handlers } = recorder();
    const sleep = () => {
      controller.abort(new Error("left the page"));
      return Promise.resolve();
    };
    await expect(followGame(api, "g1", handlers, { signal: controller.signal, sleep })).rejects.toThrow("left the page");
  });
});

describe("waiting for an unthrottled Game", () => {
  it("checks the Game every few seconds and returns it once it is Finished", async () => {
    const { api, fake } = await signedIn({}, [{ ...running, pace: "unthrottled" }]);
    const waits: number[] = [];
    let checks = 0;
    const sleep = (ms: number) => {
      waits.push(ms);
      if (++checks === 3) fake.games[0] = { ...finished, pace: "unthrottled" };
      return Promise.resolve();
    };
    const game = await waitWhileRunning(api, "g1", { signal: new AbortController().signal, sleep });
    expect(game.state).toBe("finished");
    expect(waits).toEqual([WAIT_POLL_MS, WAIT_POLL_MS, WAIT_POLL_MS]);
    expect(fake.requests.filter((r) => r === "GET /games/g1")).toHaveLength(3);
  });

  it("passes on a failure other than an unreachable server", async () => {
    const { api } = await signedIn({}, []);
    const sleep = () => Promise.resolve();
    await expect(waitWhileRunning(api, "g1", { signal: new AbortController().signal, sleep })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("assembling a live Replay", () => {
  const ticksOf = (live: LiveReplay) => (live.replay() as Replay | undefined)?.ticks.map((t) => t.tick);

  it("starts from the snapshot and adds each Tick after it", () => {
    const live = new LiveReplay();
    expect(live.replay()).toBeUndefined();
    live.tick(golden.ticks[4]);
    expect(live.replay()).toBeUndefined();
    live.snapshot(snapshot(5).replay);
    live.tick(golden.ticks[6]);
    live.tick(golden.ticks[6]);
    live.tick(golden.ticks[3]);
    expect(ticksOf(live)).toEqual([5, 6]);
    expect(live.lastTick).toBe(6);
  });

  it("continues from a fresh snapshot that follows on, and starts again from one after missed Ticks", () => {
    const live = new LiveReplay();
    live.snapshot(snapshot(5).replay);
    live.snapshot(snapshot(6).replay);
    live.snapshot(snapshot(6).replay);
    expect(ticksOf(live)).toEqual([5, 6]);
    live.snapshot(snapshot(9).replay);
    expect(ticksOf(live)).toEqual([9]);
  });

  it("is watched through the Ruleset's viewer, from the moment of joining", () => {
    const live = new LiveReplay();
    live.snapshot(snapshot(5).replay);
    for (const t of [6, 7, 8]) live.tick(golden.ticks[t]);
    const replay = r1Viewer.load(live.replay());
    expect(replay.firstTick).toBe(5);
    expect(replay.lastTick).toBe(8);
    const full = r1Viewer.load(golden);
    expect(replay.scene(0).bots).toEqual(full.scene(5).bots);
    expect(replay.scene(6.5).bots).toEqual(full.scene(6.5).bots);
  });
});

describe("the live clock", () => {
  it("runs at the Game's pace and waits at the latest Tick", () => {
    expect(liveTime(10, 0.1, 20, 15)).toBeCloseTo(12, 9);
    expect(liveTime(14.5, 0.1, 20, 15)).toBe(15);
  });

  it("catches up when it falls too far behind", () => {
    expect(liveTime(10, 0.05, 20, 40)).toBe(39);
    expect(liveTime(30, 0.05, 20, 40)).toBeCloseTo(31, 9);
  });
});

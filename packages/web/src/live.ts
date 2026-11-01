/**
 * Watching a Running Game (frontend spec section 6). A real-time Game is
 * followed on `GET /games/{id}/stream`: a `snapshot` first, then a `tick` for
 * every Tick after it, then `end` with the Finished Game. A stream that closes
 * without `end` is reopened for a fresh snapshot, waiting a little longer
 * each time it closes again without an event in between. An unthrottled Game
 * is not streamed; its page checks the Game every few seconds until it is
 * no longer Running.
 */

import { ApiError, type ApiClient, type Schema } from "./api/client.js";
import { getGame, type Game } from "./games.js";
import type { Time } from "./viewer/scene.js";

export type GameSnapshot = Schema<"GameSnapshot">;
export type GameEnded = Schema<"GameEnded">;

export interface StreamEvent {
  /** The event name; `message` when the server gave none. */
  readonly event: string;
  /** This event's own id; unlike EventSource's lastEventId, it does not carry over to later events. */
  readonly id?: string;
  readonly data: string;
}

/**
 * The events of a `text/event-stream` body, in order, until the body ends.
 * Comment lines (the server's heartbeats) are skipped. A read failure, such
 * as a dropped connection, is thrown from the iteration.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length > 0) yield { event: event ?? "message", ...(id === undefined ? {} : { id }), data: data.join("\n") };
          event = undefined;
          id = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The waits before each reopening of the stream in a row; after the last, it keeps waiting that long. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000];

/** How often an unthrottled Running Game is checked. */
export const WAIT_POLL_MS = 5000;

export interface StreamHandlers {
  readonly onSnapshot: (snapshot: GameSnapshot) => void;
  /** A Tick's frame, as the Ruleset's Replays hold them. */
  readonly onTick: (tick: unknown) => void;
  /** The stream closed without `end`; it is reopened after `delayMs`. */
  readonly onReconnecting: (delayMs: number) => void;
}

export interface WaitOptions {
  readonly signal: AbortSignal;
  /** Waits `ms`, or less if `signal` aborts; a stand-in for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Follows Game `gameId`'s stream until `end`, and returns the Finished Game.
 * The stream is reopened whenever it closes early or the server cannot be
 * reached; any other failure (the Game is not Running, say) is thrown.
 * Aborting `signal` stops following and rejects with its reason.
 */
export async function followGame(api: ApiClient, gameId: string, handlers: StreamHandlers, { signal, sleep = abortableSleep }: WaitOptions): Promise<Game> {
  let attempt = 0;
  let lastEventId: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    try {
      const body = await api.openStream(`/games/${encodeURIComponent(gameId)}/stream`, { signal, ...(lastEventId === undefined ? {} : { lastEventId }) });
      for await (const event of readEvents(body)) {
        attempt = 0;
        if (event.id !== undefined) lastEventId = event.id;
        const data = JSON.parse(event.data) as unknown;
        if (event.event === "snapshot") handlers.onSnapshot(data as GameSnapshot);
        else if (event.event === "tick") handlers.onTick(data);
        else if (event.event === "end") return (data as GameEnded).game;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError && error.status !== 0 && error.status < 500) throw error;
      // Otherwise the server was away or the connection dropped: reopen, as for a closed stream.
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 0;
    attempt++;
    handlers.onReconnecting(delay);
    await sleep(delay, signal);
  }
}

/**
 * Checks Game `gameId` every WAIT_POLL_MS until it is no longer Running, and
 * returns it. A check that cannot reach the server is tried again at the next.
 */
export async function waitWhileRunning(api: ApiClient, gameId: string, { signal, sleep = abortableSleep }: WaitOptions): Promise<Game> {
  for (;;) {
    await sleep(WAIT_POLL_MS, signal);
    signal.throwIfAborted();
    try {
      const game = await getGame(api, gameId);
      if (game.state !== "running") return game;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 0) throw error;
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** A Tick's frame, as far as assembling a Replay needs it. */
interface Frame {
  readonly tick: number;
}

/**
 * A Replay assembled from the stream (v1 spec, Spectating): a snapshot's
 * header and Ticks, then every Tick after them. A fresh snapshot after a
 * reconnect continues it when it follows on; when Ticks were missed it starts
 * the Replay again from that snapshot, since a viewer's Ticks must follow each
 * other.
 */
export class LiveReplay {
  private header: Readonly<Record<string, unknown>> | undefined;
  private frames: Frame[] = [];

  /** The last Tick so far, or -1 before the first snapshot. */
  get lastTick(): number {
    return this.frames.at(-1)?.tick ?? -1;
  }

  /** Takes a snapshot's Replay: a header and its latest Ticks. */
  snapshot(replay: unknown): void {
    const { ticks, ...header } = replay as { readonly ticks: readonly Frame[] };
    this.header = header;
    const fresh = ticks.filter((frame) => frame.tick > this.lastTick);
    const first = fresh[0];
    if (first !== undefined && first.tick !== this.lastTick + 1) this.frames = [];
    for (const frame of fresh) this.tick(frame);
  }

  /** Adds one Tick, if it is after those so far. */
  tick(frame: unknown): void {
    const next = frame as Frame;
    if (this.header === undefined || next.tick <= this.lastTick) return;
    if (this.frames.length > 0 && next.tick !== this.lastTick + 1) this.frames = [];
    this.frames.push(next);
  }

  /** The Replay so far, as the API sends Replays, or undefined before the first snapshot. */
  replay(): unknown {
    return this.header === undefined || this.frames.length === 0 ? undefined : { ...this.header, ticks: this.frames.slice() };
  }
}

/**
 * The live view's clock: `time` after `seconds` of real time, for a Game of
 * `tickRate` Ticks per second whose latest Tick is `lastTick`. It runs at the
 * Game's own pace and waits at the latest Tick; when it has fallen more than
 * LIVE_LAG_SECONDS behind, it skips to a Tick before the latest, so the view
 * stays at the moment of watching and Bots still move between Ticks.
 */
export function liveTime(time: Time, seconds: number, tickRate: number, lastTick: number): Time {
  const next = Math.min(time + seconds * tickRate, lastTick);
  return next < lastTick - LIVE_LAG_SECONDS * tickRate ? lastTick - 1 : next;
}

export const LIVE_LAG_SECONDS = 0.5;

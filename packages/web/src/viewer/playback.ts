/**
 * Replay time controls (frontend spec section 6): play and pause, a
 * scrubber over the whole Game, speeds from 0.25x to 4x, and skipping to the
 * result. Playback stops at the last Tick.
 */

import type { Time } from "./scene.js";

export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

export interface Playback {
  /** The moment shown, in Ticks. */
  readonly time: Time;
  readonly playing: boolean;
  /** Simulated seconds per real second. */
  readonly speed: number;
}

/** A Replay's playback before it starts: Tick 0, playing, at 1x. */
export const START: Playback = { time: 0, playing: true, speed: 1 };

/** `playback` after `seconds` of real time, for a Game of `tickRate` Ticks per second ending at `lastTick`. */
export function advance(playback: Playback, seconds: number, tickRate: number, lastTick: number): Playback {
  if (!playback.playing) return playback;
  const time = Math.min(playback.time + seconds * playback.speed * tickRate, lastTick);
  return { ...playback, time, playing: time < lastTick };
}

/** Plays or pauses; playing from the end starts again from Tick 0. */
export function togglePlaying(playback: Playback, lastTick: number): Playback {
  if (playback.playing) return { ...playback, playing: false };
  return { ...playback, playing: true, time: playback.time >= lastTick ? 0 : playback.time };
}

/** Moves to `time`, kept within the Game. */
export function seek(playback: Playback, time: Time, lastTick: number): Playback {
  return { ...playback, time: Math.min(Math.max(time, 0), lastTick) };
}

/** Skips to the result: the last Tick, paused. */
export function skipToEnd(playback: Playback, lastTick: number): Playback {
  return { ...playback, time: lastTick, playing: false };
}

/** A moment as the scrubber labels it: simulated minutes and seconds. */
export function clockText(time: Time, tickRate: number): string {
  const seconds = Math.floor(time / tickRate);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

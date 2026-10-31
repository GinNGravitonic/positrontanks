import { describe, expect, it } from "vitest";
import { advance, clockText, seek, skipToEnd, START, togglePlaying } from "./playback.js";

describe("Replay playback", () => {
  it("plays from Tick 0 at the speed chosen, in simulated time", () => {
    expect(advance(START, 0.5, 20, 100).time).toBe(10);
    expect(advance({ ...START, speed: 0.25 }, 1, 20, 100).time).toBe(5);
    expect(advance({ ...START, speed: 4 }, 1, 20, 100).time).toBe(80);
  });

  it("stops at the last Tick, and stands still while paused", () => {
    expect(advance(START, 60, 20, 100)).toEqual({ time: 100, playing: false, speed: 1 });
    const paused = { ...START, playing: false };
    expect(advance(paused, 1, 20, 100)).toBe(paused);
  });

  it("plays again from Tick 0 once at the end", () => {
    expect(togglePlaying({ time: 100, playing: false, speed: 2 }, 100)).toEqual({ time: 0, playing: true, speed: 2 });
    expect(togglePlaying({ time: 40, playing: false, speed: 1 }, 100).time).toBe(40);
    expect(togglePlaying({ time: 40, playing: true, speed: 1 }, 100).playing).toBe(false);
  });

  it("seeks within the Game, and skips to the result paused", () => {
    expect(seek(START, 140, 100).time).toBe(100);
    expect(seek(START, -3, 100).time).toBe(0);
    expect(skipToEnd(START, 100)).toEqual({ time: 100, playing: false, speed: 1 });
  });

  it("labels moments in simulated minutes and seconds", () => {
    expect(clockText(0, 20)).toBe("0:00");
    expect(clockText(1219, 20)).toBe("1:00");
    expect(clockText(2400, 20)).toBe("2:00");
  });
});

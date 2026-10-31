/**
 * Watching a Game (frontend spec sections 6 and 7): a Finished Game's
 * Replay in the viewer, from Tick 0, with its time controls; a Game of a
 * Ruleset without a viewer says so instead. The main view pans by dragging
 * and zooms with the wheel or its buttons; the overview moves it by a click
 * or a drag.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ApiError } from "../api/client.js";
import { botParts, type Catalog } from "../draw/bot.js";
import { fitView, screenToMap, type View } from "../draw/geometry.js";
import { mapBounds } from "../draw/map.js";
import { Canvas } from "../draw/preview.js";
import { cancelReasonText, getGame, problemText, resultText, type Game } from "../games.js";
import { Link, useLoad, useServices, useSession } from "../hooks.js";
import { loadReplay } from "../replays.js";
import { centerOn, defaultView, panBy, resizeView, zoomAt } from "../viewer/camera.js";
import { drawMainView, drawOverview, type BotLooks } from "../viewer/draw-scene.js";
import { advance, clockText, seek, skipToEnd, SPEEDS, START, togglePlaying, type Playback } from "../viewer/playback.js";
import type { ViewerReplay } from "../viewer/scene.js";
import { unsupportedText } from "../viewer/viewers.js";
import { gameRoute } from "./game.js";

export function WatchScreen({ id }: { readonly id: string }) {
  const { api } = useServices();
  const game = useLoad(() => getGame(api, id), id);
  if (game.status === "loading") return <p>Loading…</p>;
  if (game.status === "failed") {
    return (
      <p className="error" role="alert">
        {game.error instanceof ApiError && game.error.status === 404 ? `There is no Game ${id}.` : problemText(game.error)}
      </p>
    );
  }
  return <WatchGame game={game.value} />;
}

/** What there is to watch of `game`, by its state. */
export function WatchGame({ game }: { readonly game: Game }) {
  const back = (
    <p>
      <Link to={gameRoute(game.id)}>Back to the Game</Link>
    </p>
  );
  switch (game.state) {
    case "finished":
      return <FinishedGame game={game} />;
    case "running":
      return (
        <>
          <h2>Watch Game</h2>
          <p>
            Watching Running Games is not in the web client yet. Meanwhile, use the CLI: <code>{`positrontanks games watch ${game.id}`}</code>
          </p>
          {back}
        </>
      );
    case "open":
      return (
        <>
          <h2>Watch Game</h2>
          <p>This Game has not started yet.</p>
          {back}
        </>
      );
    case "cancelled":
      return (
        <>
          <h2>Watch Game</h2>
          <p>{cancelReasonText(game)} It has no Replay.</p>
          {back}
        </>
      );
  }
}

function FinishedGame({ game }: { readonly game: Game }) {
  const { api } = useServices();
  const loaded = useLoad(() => loadReplay(api, game), game.id);
  if (loaded.status === "loading") return <p>Loading the Replay…</p>;
  if (loaded.status === "failed") {
    return (
      <p className="error" role="alert">
        {loaded.error instanceof ApiError ? problemText(loaded.error) : "This Replay cannot be shown."}
      </p>
    );
  }
  if (loaded.value.kind === "unsupported") {
    return (
      <>
        <h2>{game.map.name}</h2>
        <p>{unsupportedText(loaded.value.version)}</p>
        <p>
          <Link to={gameRoute(game.id)}>Back to the Game</Link>
        </p>
      </>
    );
  }
  return <ReplayViewer game={game} replay={loaded.value.replay} catalog={loaded.value.catalog} />;
}

/** Each Bot's name and drawn parts, by Bot id. */
export function botLooks(replay: ViewerReplay, catalog: Catalog): Map<number, BotLooks> {
  return new Map(replay.entries.flatMap((entry) => entry.bots.map((bot) => [bot.id, { name: bot.name, parts: botParts(catalog, bot.build) }] as const)));
}

/** Where the main view starts: on the signed-in Player's first Bot if they have one, otherwise on the first Bot. */
export function startingBot(replay: ViewerReplay, playerId: string | undefined): number | undefined {
  const own = replay.entries.find((entry) => entry.player === playerId);
  return (own ?? replay.entries[0])?.bots[0]?.id;
}

const OVERVIEW_SIZE = 200;
const ZOOM_STEP = 1.25;
/** The longest real-time step played at once, so a hidden tab does not jump ahead when shown again. */
const MAX_FRAME_SECONDS = 0.25;

function ReplayViewer({ game, replay, catalog }: { readonly game: Game; readonly replay: ViewerReplay; readonly catalog: Catalog }) {
  const playerId = useSession()?.player.id;
  const looks = useMemo(() => botLooks(replay, catalog), [replay, catalog]);
  const bounds = useMemo(() => mapBounds(replay.map), [replay]);
  const [playback, setPlayback] = useState<Playback>(START);
  const [view, setView] = useState<View>();
  const area = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ readonly x: number; readonly y: number }>(undefined);

  // The main view fills its area, and follows it when the window is resized.
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    const fit = () => {
      const width = Math.max(1, Math.floor(element.clientWidth));
      const height = Math.max(1, Math.floor(element.clientHeight));
      setView((current) => {
        if (current !== undefined) return current.width === width && current.height === height ? current : resizeView(current, bounds, width, height);
        const first = startingBot(replay, playerId);
        const bot = replay.scene(0).bots.find((b) => b.id === first);
        return defaultView(bounds, width, height, bot);
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [bounds, replay, playerId]);

  useEffect(() => {
    if (!playback.playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const seconds = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;
      setPlayback((p) => advance(p, seconds, replay.tickRate, replay.lastTick));
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playback.playing, replay]);

  // The wheel zooms the main view; React's wheel listeners cannot stop the page from scrolling.
  const shown = view !== undefined;
  useEffect(() => {
    const canvas = main.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setView((v) => (v === undefined ? v : zoomAt(v, bounds, at, Math.exp(-event.deltaY * 0.0015))));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [bounds, shown]);

  const scene = replay.scene(playback.time);
  const atEnd = playback.time >= replay.lastTick;
  const overviewScale = OVERVIEW_SIZE / Math.max(replay.map.width, replay.map.height);
  const overviewWidth = Math.round(replay.map.width * overviewScale);
  const overviewHeight = Math.round(replay.map.height * overviewScale);
  const overviewView = fitView(bounds, overviewWidth, overviewHeight, 1 / overviewScale);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const zoomBy = (factor: number) => {
    setView((v) => (v === undefined ? v : zoomAt(v, bounds, { x: v.width / 2, y: v.height / 2 }, factor)));
  };
  const moveTo = (event: PointerEvent<HTMLCanvasElement>) => {
    const target = screenToMap(overviewView, point(event));
    setView((v) => (v === undefined ? v : centerOn(v, bounds, target)));
  };

  return (
    <section className="viewer">
      <h2>
        {game.map.name} <span className="state finished">Replay</span>
      </h2>
      <div className="viewer-views">
        <div className="viewer-main" ref={area}>
          {view === undefined ? null : (
            <Canvas
              canvasRef={main}
              width={view.width}
              height={view.height}
              label="The main view of the Game"
              draw={(ctx) => {
                drawMainView(ctx, view, replay, scene, looks);
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = point(event);
              }}
              onPointerMove={(event) => {
                const from = drag.current;
                if (from === undefined) return;
                const to = point(event);
                drag.current = to;
                setView((v) => (v === undefined ? v : panBy(v, bounds, to.x - from.x, to.y - from.y)));
              }}
              onPointerUp={() => {
                drag.current = undefined;
              }}
            />
          )}
          <div className="viewer-zoom">
            <button type="button" aria-label="Zoom in" onClick={() => {
              zoomBy(ZOOM_STEP);
            }}>
              +
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => {
              zoomBy(1 / ZOOM_STEP);
            }}>
              −
            </button>
          </div>
        </div>
        <div className="viewer-side">
          {view === undefined ? null : (
            <Canvas
              className="viewer-overview"
              width={overviewWidth}
              height={overviewHeight}
              label="Overview of the whole Map"
              draw={(ctx) => {
                drawOverview(ctx, overviewView, replay, scene, view);
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                moveTo(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons !== 0) moveTo(event);
              }}
            />
          )}
          {atEnd && game.result !== null ? <p className="viewer-result">{resultText(game.result)}.</p> : null}
        </div>
      </div>
      <ReplayControls
        playback={playback}
        tickRate={replay.tickRate}
        lastTick={replay.lastTick}
        onChange={(change) => {
          setPlayback((p) => change(p));
        }}
      />
      <p>
        <Link to={gameRoute(game.id)}>Back to the Game</Link>
      </p>
    </section>
  );
}

export interface ReplayControlsProps {
  readonly playback: Playback;
  readonly tickRate: number;
  readonly lastTick: number;
  /** Applies a change to the playback. */
  readonly onChange: (change: (playback: Playback) => Playback) => void;
}

/** Play and pause, the scrubber, the speed and "Skip to result". */
export function ReplayControls({ playback, tickRate, lastTick, onChange }: ReplayControlsProps) {
  return (
    <div className="replay-controls">
      <button
        type="button"
        onClick={() => {
          onChange((p) => togglePlaying(p, lastTick));
        }}
      >
        {playback.playing ? "Pause" : "Play"}
      </button>
      <input
        type="range"
        aria-label="Time"
        min={0}
        max={lastTick}
        step="any"
        value={playback.time}
        onChange={(event) => {
          const time = Number(event.target.value);
          onChange((p) => seek(p, time, lastTick));
        }}
      />
      <span className="clock">
        {clockText(playback.time, tickRate)} / {clockText(lastTick, tickRate)}
      </span>
      <label>
        Speed{" "}
        <select
          value={playback.speed}
          onChange={(event) => {
            const speed = Number(event.target.value);
            onChange((p) => ({ ...p, speed }));
          }}
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {`${String(speed)}x`}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={playback.time >= lastTick}
        onClick={() => {
          onChange((p) => skipToEnd(p, lastTick));
        }}
      >
        Skip to result
      </button>
    </div>
  );
}

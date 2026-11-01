/**
 * Watching a Game (frontend spec sections 6 and 7): a real-time Running Game
 * live from its stream, from the moment of joining and with no time
 * controls; an unthrottled Running Game's waiting page, which switches to the
 * Replay once the Game is Finished; a Finished Game's Replay from Tick 0, with
 * its time controls. A Game of a Ruleset without a viewer says so instead.
 * The main view pans by dragging and zooms with the wheel or its buttons; the
 * overview moves it by a click or a drag. Clicking a Bot selects it and opens
 * its inset, whose Follow button follows it until the Spectator pans. Game
 * Over is shown over the final frame when a Replay's playback reaches the
 * end, or when a live Game ends.
 */

import type { Point } from "@positrontanks/ruleset-data";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import { botParts, botReach, type Catalog } from "../draw/bot.js";
import { fitView, screenToMap, type View } from "../draw/geometry.js";
import { mapBounds } from "../draw/map.js";
import { Canvas } from "../draw/preview.js";
import { cancelReasonText, getGame, problemText, type Game } from "../games.js";
import { Link, useLoad, useServices, useSession } from "../hooks.js";
import { followGame, liveTime, LiveReplay, WAIT_POLL_MS, waitWhileRunning } from "../live.js";
import { getPartsCatalog, loadReplay, type LoadedReplay } from "../replays.js";
import { centerOn, defaultView, panBy, resizeView, zoomAt } from "../viewer/camera.js";
import { drawMainView, drawOverview, type BotLooks } from "../viewer/draw-scene.js";
import { botAt, follow, followStep, zoomFollowing, type Camera } from "../viewer/follow.js";
import { advance, clockText, seek, skipToEnd, SPEEDS, START, togglePlaying, type Playback } from "../viewer/playback.js";
import type { Time, ViewerReplay } from "../viewer/scene.js";
import { unsupportedText, viewerFor } from "../viewer/viewers.js";
import { BotInset } from "./bot-inset.js";
import { GameOver } from "./game-over.js";
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
  return <WatchGame key={id} game={game.value} />;
}

/**
 * What there is to watch of `game`, by its state. A Game watched live or
 * waited for here moves on to its Replay once it is Finished.
 */
export function WatchGame({ game: first }: { readonly game: Game }) {
  const [game, setGame] = useState(first);
  /** The Finished Game's Replay, when it was already loaded on the way here. */
  const [loaded, setLoaded] = useState<LoadedReplay>();
  const back = <BackToGame id={game.id} />;
  switch (game.state) {
    case "finished":
      return <FinishedGame game={game} {...(loaded === undefined ? {} : { loaded })} />;
    case "running":
      return game.pace === "realtime" ? (
        <LiveGame
          game={game}
          onWatchAgain={(finished, replay) => {
            setLoaded(replay);
            setGame(finished);
          }}
        />
      ) : (
        <WaitingGame game={game} onChanged={setGame} />
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

function BackToGame({ id }: { readonly id: string }) {
  return (
    <p>
      <Link to={gameRoute(id)}>Back to the Game</Link>
    </p>
  );
}

export interface WaitingGameProps {
  readonly game: Game;
  /** Called with the Game once it is no longer Running. */
  readonly onChanged: (game: Game) => void;
}

/** An unthrottled Running Game: says its Replay comes when it is Finished, and checks every few seconds until it is no longer Running. */
export function WaitingGame({ game, onChanged }: WaitingGameProps) {
  const { api } = useServices();
  const [problem, setProblem] = useState<string>();
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    const controller = new AbortController();
    waitWhileRunning(api, game.id, { signal: controller.signal }).then(
      (now) => {
        changed.current(now);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProblem(problemText(error));
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, game.id]);
  return (
    <>
      <h2>
        {game.map.name} <span className="state running">Being played</span>
      </h2>
      <p>
        This Game is being played at unthrottled Pace, so it cannot be watched live. Its Replay comes when it is Finished; this page checks every{" "}
        {String(WAIT_POLL_MS / 1000)} seconds and shows the Replay as soon as it is.
      </p>
      {problem === undefined ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <BackToGame id={game.id} />
    </>
  );
}

/** How the live stream is going. */
type LiveStatus = "joining" | "live" | "reconnecting";

/**
 * A real-time Running Game, live from its stream. When the Game ends, its
 * Replay is loaded and Game Over shown over the final frame; watching again
 * moves on to the Replay.
 */
function LiveGame({ game, onWatchAgain }: { readonly game: Game; readonly onWatchAgain: (finished: Game, replay: LoadedReplay) => void }) {
  const { api } = useServices();
  const viewer = viewerFor(game.rulesetVersion);
  const catalog = useLoad(() => getPartsCatalog(api, game.rulesetVersion), game.rulesetVersion);
  const [replay, setReplay] = useState<ViewerReplay>();
  const [status, setStatus] = useState<LiveStatus>("joining");
  const [time, setTime] = useState<Time>();
  const [ended, setEnded] = useState<{ readonly game: Game; readonly replay?: LoadedReplay }>();
  const [problem, setProblem] = useState<unknown>();
  const latest = useRef(replay);
  latest.current = replay;

  useEffect(() => {
    if (viewer === undefined) return;
    const controller = new AbortController();
    const live = new LiveReplay();
    // The Replay so far is read for the viewer at most once a frame, however fast Ticks come.
    let frame = 0;
    const show = () => {
      frame = 0;
      const json = live.replay();
      if (json !== undefined) setReplay(viewer.load(json));
    };
    const changed = () => {
      if (frame === 0) frame = requestAnimationFrame(show);
    };
    followGame(
      api,
      game.id,
      {
        onSnapshot: (snapshot) => {
          live.snapshot(snapshot.replay);
          setStatus("live");
          changed();
        },
        onTick: (tick) => {
          live.tick(tick);
          changed();
        },
        onReconnecting: () => {
          setStatus("reconnecting");
        },
      },
      { signal: controller.signal },
    )
      .then(async (finished) => {
        cancelAnimationFrame(frame);
        show();
        setEnded({ game: finished });
        const full = await loadReplay(api, finished);
        if (!controller.signal.aborted) setEnded({ game: finished, replay: full });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(error);
      });
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [api, game.id, viewer]);

  // The live clock runs at the Game's pace, just behind the latest Tick.
  const started = replay !== undefined;
  useEffect(() => {
    if (!started) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const seconds = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;
      const r = latest.current;
      if (r !== undefined) setTime((t) => liveTime(t ?? r.lastTick, seconds, r.tickRate, r.lastTick));
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [started]);

  if (viewer === undefined) {
    return (
      <>
        <h2>{game.map.name}</h2>
        <p>{unsupportedText(game.rulesetVersion)}</p>
        <BackToGame id={game.id} />
      </>
    );
  }
  if (problem !== undefined || catalog.status === "failed") {
    return (
      <>
        <p className="error" role="alert">
          {problemText(catalog.status === "failed" ? catalog.error : problem)}
        </p>
        <BackToGame id={game.id} />
      </>
    );
  }
  if (replay === undefined || catalog.status === "loading") return <p>Joining the Game…</p>;

  // Once the Game has ended and its Replay is loaded, the final frame is the Replay's, and Game Over shows over it.
  const final = ended?.replay?.kind === "replay" ? ended.replay : undefined;
  const result = ended?.game.result ?? null;
  const badge =
    ended !== undefined ? (
      <span className="state finished">Game over</span>
    ) : (
      <span className="state running">{status === "reconnecting" ? "Live, reconnecting…" : "Live"}</span>
    );
  return (
    <Viewer
      game={ended?.game ?? game}
      replay={final?.replay ?? replay}
      catalog={final?.catalog ?? catalog.value}
      time={final === undefined ? Math.min(time ?? replay.lastTick, replay.lastTick) : final.replay.lastTick}
      badge={badge}
      overlay={
        ended !== undefined && final !== undefined && result !== null ? (
          <GameOver
            result={result}
            replay={final.replay}
            usernames={usernamesOf(ended.game)}
            onWatchAgain={() => {
              onWatchAgain(ended.game, final);
            }}
          />
        ) : null
      }
    />
  );
}

function FinishedGame({ game, loaded: given }: { readonly game: Game; readonly loaded?: LoadedReplay }) {
  const { api } = useServices();
  const loaded = useLoad(() => (given === undefined ? loadReplay(api, game) : Promise.resolve(given)), game.id);
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
        <BackToGame id={game.id} />
      </>
    );
  }
  return <ReplayViewer game={game} replay={loaded.value.replay} catalog={loaded.value.catalog} />;
}

/** Each Bot's name and drawn parts, by Bot id. */
export function botLooks(replay: Pick<ViewerReplay, "entries">, catalog: Catalog): Map<number, BotLooks> {
  return new Map(replay.entries.flatMap((entry) => entry.bots.map((bot) => [bot.id, { name: bot.name, parts: botParts(catalog, bot.build) }] as const)));
}

/** Where the main view starts: on the signed-in Player's first Bot if they have one, otherwise on the first Bot. */
export function startingBot(replay: ViewerReplay, playerId: string | undefined): number | undefined {
  const own = replay.entries.find((entry) => entry.player === playerId);
  return (own ?? replay.entries[0])?.bots[0]?.id;
}

/** Each Player's username, by Player id. */
function usernamesOf(game: Game): Map<string, string> {
  return new Map(game.entries.map((entry) => [entry.player.id, entry.player.username]));
}

const OVERVIEW_SIZE = 200;
/** How far, in CSS pixels, a press may move and still be a click rather than a drag. */
const CLICK_PIXELS = 4;
/** Extra reach, in CSS pixels, for clicking a Bot. */
const CLICK_SLOP = 6;
/** The reach of a Bot drawn as a plain disc, in meters. */
const DISC_REACH = 0.5;
const ZOOM_STEP = 1.25;
/** The longest real-time step played at once, so a hidden tab does not jump ahead when shown again. */
const MAX_FRAME_SECONDS = 0.25;

/** A Finished Game's Replay, played from Tick 0 with its time controls; Game Over at the end. */
function ReplayViewer({ game, replay, catalog }: { readonly game: Game; readonly replay: ViewerReplay; readonly catalog: Catalog }) {
  const [playback, setPlayback] = useState<Playback>(START);
  const usernames = useMemo(() => usernamesOf(game), [game]);

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

  const atEnd = playback.time >= replay.lastTick;
  return (
    <Viewer
      game={game}
      replay={replay}
      catalog={catalog}
      time={playback.time}
      badge={<span className="state finished">Replay</span>}
      overlay={
        atEnd && game.result !== null ? (
          <GameOver
            result={game.result}
            replay={replay}
            usernames={usernames}
            onWatchAgain={() => {
              setPlayback((p) => ({ ...seek(p, 0, replay.lastTick), playing: true }));
            }}
          />
        ) : null
      }
      controls={
        <ReplayControls
          playback={playback}
          tickRate={replay.tickRate}
          lastTick={replay.lastTick}
          onChange={(change) => {
            setPlayback((p) => change(p));
          }}
        />
      }
    />
  );
}

interface ViewerProps {
  readonly game: Game;
  readonly replay: ViewerReplay;
  readonly catalog: Catalog;
  /** The moment shown. */
  readonly time: Time;
  /** Shown beside the Map's name. */
  readonly badge: ReactNode;
  /** Shown over the main view, such as Game Over. */
  readonly overlay?: ReactNode;
  /** Shown under the views, such as the time controls. */
  readonly controls?: ReactNode;
}

/** The main view and the overview of `replay` at `time`, with the Bot inset and following. */
function Viewer({ game, replay, catalog, time, badge, overlay, controls }: ViewerProps) {
  const playerId = useSession()?.player.id;
  // A live Replay is read again with every Tick, keeping its Map and Entries.
  const { map, entries } = replay;
  const looks = useMemo(() => botLooks({ entries }, catalog), [entries, catalog]);
  const bounds = useMemo(() => mapBounds(map), [map]);
  const [camera, setCamera] = useState<Camera>();
  /** The Bot whose inset is open. */
  const [selected, setSelected] = useState<number>();
  const usernames = useMemo(() => usernamesOf(game), [game]);
  const view = camera?.view;
  const area = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  /** A press on the main view: where it started, where it is now, and whether it has become a drag. */
  const press = useRef<{ readonly start: Point; readonly at: Point; readonly dragging: boolean }>(undefined);
  const latest = useRef({ replay, time });
  latest.current = { replay, time };
  /** Moves the view by hand, which stops following. */
  const moveView = (change: (view: View) => View) => {
    setCamera((c) => (c === undefined ? c : { view: change(c.view) }));
  };

  // The main view fills its area, and follows it when the window is resized.
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    const fit = () => {
      const width = Math.max(1, Math.floor(element.clientWidth));
      const height = Math.max(1, Math.floor(element.clientHeight));
      setCamera((current) => {
        if (current !== undefined) {
          const { view: v } = current;
          return v.width === width && v.height === height ? current : { ...current, view: resizeView(v, bounds, width, height) };
        }
        const r = latest.current.replay;
        const first = startingBot(r, playerId);
        const bot = r.scene(r.firstTick).bots.find((b) => b.id === first);
        return { view: defaultView(bounds, width, height, bot) };
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [bounds, playerId]);

  // While following, the camera tracks the followed Bot every frame, paused or not.
  const followed = camera?.following?.bot;
  useEffect(() => {
    if (followed === undefined) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const seconds = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;
      const { replay: r, time: t } = latest.current;
      const scene = r.scene(t);
      setCamera((c) => (c === undefined ? c : followStep(c, bounds, scene, r.hits, r.tickRate, seconds)));
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [followed, bounds]);

  // The wheel zooms the main view; React's wheel listeners cannot stop the page from scrolling.
  const shown = view !== undefined;
  useEffect(() => {
    const canvas = main.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0015);
      setCamera((c) => (c === undefined ? c : c.following === undefined ? { view: zoomAt(c.view, bounds, at, factor) } : zoomFollowing(c, bounds, factor)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [bounds, shown]);

  const scene = replay.scene(time);
  const overviewScale = OVERVIEW_SIZE / Math.max(map.width, map.height);
  const overviewWidth = Math.round(map.width * overviewScale);
  const overviewHeight = Math.round(map.height * overviewScale);
  const overviewView = fitView(bounds, overviewWidth, overviewHeight, 1 / overviewScale);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const zoomBy = (factor: number) => {
    setCamera((c) => (c === undefined ? c : zoomFollowing(c, bounds, factor)));
  };
  const moveTo = (event: PointerEvent<HTMLCanvasElement>) => {
    const target = screenToMap(overviewView, point(event));
    moveView((v) => centerOn(v, bounds, target));
  };
  const reach = (bot: number) => {
    const parts = looks.get(bot)?.parts;
    return (parts === undefined ? DISC_REACH : botReach(parts)) + (view === undefined ? 0 : CLICK_SLOP / view.scale);
  };
  /** Selects the Bot clicked at `at` on the main view, or none if no Bot is there. */
  const clickAt = (at: Point) => {
    if (view === undefined) return;
    setSelected(botAt(scene, screenToMap(view, at), reach));
  };
  const followedName = followed === undefined ? undefined : looks.get(followed)?.name;

  return (
    <section className="viewer">
      <h2>
        {game.map.name} {badge}
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
                drawMainView(ctx, view, replay, scene, looks, selected);
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const at = point(event);
                press.current = { start: at, at, dragging: false };
              }}
              onPointerMove={(event) => {
                const from = press.current;
                if (from === undefined) return;
                const to = point(event);
                const dragging = from.dragging || Math.hypot(to.x - from.start.x, to.y - from.start.y) > CLICK_PIXELS;
                press.current = { ...from, at: to, dragging };
                if (dragging) moveView((v) => panBy(v, bounds, to.x - from.at.x, to.y - from.at.y));
              }}
              onPointerUp={() => {
                const from = press.current;
                press.current = undefined;
                if (from !== undefined && !from.dragging) clickAt(from.start);
              }}
            />
          )}
          {selected === undefined ? null : (
            <BotInset
              replay={replay}
              catalog={catalog}
              scene={scene}
              bot={selected}
              looks={looks.get(selected)}
              usernames={usernames}
              following={followed === selected}
              onFollow={() => {
                setCamera((c) => (c === undefined ? c : follow(c, selected)));
              }}
              onStopFollowing={() => {
                moveView((v) => v);
              }}
              onClose={() => {
                setSelected(undefined);
              }}
            />
          )}
          {overlay}
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
          <p className="viewer-following">
            {followedName === undefined ? (
              "Click a Bot to see it."
            ) : (
              <>
                Following <strong>{followedName}</strong>{" "}
                <button
                  type="button"
                  onClick={() => {
                    moveView((v) => v);
                  }}
                >
                  Stop following
                </button>
              </>
            )}
          </p>
        </div>
      </div>
      {controls}
      <BackToGame id={game.id} />
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

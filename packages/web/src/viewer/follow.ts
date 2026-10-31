/**
 * Following a Bot (frontend spec section 7, Following a Bot): the main view
 * tracks the followed Bot and fits every Bot engaged with it, that is, linked
 * to it by a hit in the last few simulated seconds, either way. With no Bot
 * engaged it eases back to the default zoom. Zooming by hand keeps following
 * on and scales the framing; panning stops it, and so does the followed Bot
 * being Disabled, which leaves the camera where it is.
 */

import type { Point } from "@positrontanks/ruleset-data";
import { boundsOf, fitView, type Bounds, type View } from "../draw/geometry.js";
import { clampView, zoomLimits } from "./camera.js";
import type { Hit, Scene, Time } from "./scene.js";

/** How long a hit keeps two Bots engaged, in simulated seconds. */
export const ENGAGEMENT_SECONDS = 3;
/** Meters kept around the followed and engaged Bots when fitting them. */
export const FIT_MARGIN = 3;
/** How quickly the camera eases to its framing: the real seconds to cover about two thirds of the way. */
export const EASE_SECONDS = 0.4;

/** The Bots engaged with `bot` at `time`: linked to it by a hit within the last {@link ENGAGEMENT_SECONDS}. */
export function engagedBots(hits: readonly Hit[], bot: number, time: Time, tickRate: number): Set<number> {
  const since = time - ENGAGEMENT_SECONDS * tickRate;
  const engaged = new Set<number>();
  for (const hit of hits) {
    if (hit.time > time) break;
    if (hit.time <= since) continue;
    const [a, b] = hit.bots;
    if (a === bot) engaged.add(b);
    else if (b === bot) engaged.add(a);
  }
  return engaged;
}

/** Following a Bot, as the camera has got so far. */
export interface Following {
  readonly bot: number;
  /** The Spectator's zoom by hand while following, as a factor on the framing; 1 at first. */
  readonly zoom: number;
}

/** A view's framing relative to the followed Bot: its scale, and its centre less the Bot's position. */
export interface Framing {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * The framing to ease towards: the default zoom on the followed Bot, or, with
 * Bots engaged, zoomed out as far as it takes to fit them all; then scaled by
 * the zoom by hand, within the zoom limits.
 */
export function targetFraming(map: Bounds, width: number, height: number, followed: Point, engaged: readonly Point[], zoom: number): Framing {
  const limits = zoomLimits(map, width, height);
  const clamp = (scale: number) => Math.min(Math.max(scale, limits.min), limits.max);
  if (engaged.length === 0) return { scale: clamp(limits.default * zoom), offsetX: 0, offsetY: 0 };
  const fit = fitView(boundsOf([followed, ...engaged]), width, height, FIT_MARGIN);
  return { scale: clamp(Math.min(limits.default, fit.scale) * zoom), offsetX: fit.centerX - followed.x, offsetY: fit.centerY - followed.y };
}

/** `view`'s framing relative to `followed`. */
export function framingOf(view: View, followed: Point): Framing {
  return { scale: view.scale, offsetX: view.centerX - followed.x, offsetY: view.centerY - followed.y };
}

/** `from` eased towards `to` over `seconds` of real time; the scale eases evenly in zoom, and both snap once close. */
export function ease(from: Framing, to: Framing, seconds: number): Framing {
  const f = 1 - Math.exp(-seconds / EASE_SECONDS);
  const ratio = to.scale / from.scale;
  const scale = Math.abs(ratio - 1) < 1e-3 ? to.scale : from.scale * ratio ** f;
  const offset = (a: number, b: number) => (Math.abs(b - a) < 1e-3 ? b : a + (b - a) * f);
  return { scale, offsetX: offset(from.offsetX, to.offsetX), offsetY: offset(from.offsetY, to.offsetY) };
}

/** The camera: the main view, and the Bot it follows, if any. */
export interface Camera {
  readonly view: View;
  readonly following?: Following;
}

/**
 * `camera` after `seconds` of real time at `scene`. The followed Bot stays
 * where its framing puts it, so it never lags; only the framing eases. A
 * camera that follows no Bot, or one gone Disabled, stops following and
 * keeps its view. The same `camera` comes back when nothing changes.
 */
export function followStep(camera: Camera, map: Bounds, scene: Scene, hits: readonly Hit[], tickRate: number, seconds: number): Camera {
  const { view, following } = camera;
  if (following === undefined) return camera;
  const bot = scene.bots.find((b) => b.id === following.bot);
  if (bot === undefined || bot.disabled) return { view };
  const engaged = engagedBots(hits, bot.id, scene.time, tickRate);
  const others = scene.bots.filter((b) => engaged.has(b.id));
  const framing = ease(framingOf(view, bot), targetFraming(map, view.width, view.height, bot, others, following.zoom), seconds);
  const next = clampView({ ...view, scale: framing.scale, centerX: bot.x + framing.offsetX, centerY: bot.y + framing.offsetY }, map, zoomLimits(map, view.width, view.height));
  return next.scale === view.scale && next.centerX === view.centerX && next.centerY === view.centerY ? camera : { view: next, following };
}

/** Starts following `bot`; the camera eases there from where it is. */
export function follow(camera: Camera, bot: number): Camera {
  return { view: camera.view, following: { bot, zoom: 1 } };
}

/**
 * Zooming by hand by `factor` while following: the view zooms about its
 * centre at once, within the zoom limits, and the framing scales by as much.
 */
export function zoomFollowing(camera: Camera, map: Bounds, factor: number): Camera {
  const { view, following } = camera;
  const limits = zoomLimits(map, view.width, view.height);
  const scale = Math.min(Math.max(view.scale * factor, limits.min), limits.max);
  const next = { ...view, scale };
  return following === undefined ? { view: next } : { view: next, following: { ...following, zoom: (following.zoom * scale) / view.scale } };
}

/** The Bot at `at`, a Map point: the nearest whose drawing, `reach` meters from its centre, covers it. */
export function botAt(scene: Scene, at: Point, reach: (bot: number) => number): number | undefined {
  let best: { readonly id: number; readonly distance: number } | undefined;
  for (const bot of scene.bots) {
    const distance = Math.hypot(bot.x - at.x, bot.y - at.y);
    if (distance <= reach(bot.id) && (best === undefined || distance < best.distance)) best = { id: bot.id, distance };
  }
  return best?.id;
}

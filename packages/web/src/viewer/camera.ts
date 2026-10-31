/**
 * The main view's camera (frontend spec section 7, Main view): panning and
 * zooming around the Map within the zoom limits, measured across the view's
 * shorter side. These are presentation values, kept in the client.
 */

import type { Point } from "@positrontanks/ruleset-data";
import { fitView, screenToMap, type Bounds, type View } from "../draw/geometry.js";

/** Meters across the shorter side at maximum zoom: about one large Bot. */
export const MAX_ZOOM_SPAN = 4;
/** Meters across the shorter side at the default zoom: two Bots at close range. */
export const DEFAULT_ZOOM_SPAN = 15;
/** Meters left around the whole Map at minimum zoom. */
export const MIN_ZOOM_MARGIN = 2;

/** The scales, in CSS pixels per meter, the main view may use. */
export interface ZoomLimits {
  /** Minimum zoom: the whole Map plus a margin. */
  readonly min: number;
  readonly default: number;
  /** Maximum zoom. */
  readonly max: number;
}

/**
 * The zoom limits for a `width` x `height` view of `map`. The margin makes
 * minimum zoom span at least 4 m, so it never passes maximum zoom; on a Map
 * smaller than the default span, the default is minimum zoom.
 */
export function zoomLimits(map: Bounds, width: number, height: number): ZoomLimits {
  const shorter = Math.min(width, height);
  const max = shorter / MAX_ZOOM_SPAN;
  const min = Math.min(fitView(map, width, height, MIN_ZOOM_MARGIN).scale, max);
  return { min, default: Math.min(Math.max(shorter / DEFAULT_ZOOM_SPAN, min), max), max };
}

/** `view` with its scale within `limits` and its centre on the Map. */
export function clampView(view: View, map: Bounds, limits: ZoomLimits): View {
  return {
    ...view,
    scale: Math.min(Math.max(view.scale, limits.min), limits.max),
    centerX: Math.min(Math.max(view.centerX, map.minX), map.maxX),
    centerY: Math.min(Math.max(view.centerY, map.minY), map.maxY),
  };
}

/** The default view of `map` at a `width` x `height` size: centred on `center`, or the Map's middle, at the default zoom. */
export function defaultView(map: Bounds, width: number, height: number, center?: Point): View {
  const limits = zoomLimits(map, width, height);
  return {
    centerX: center?.x ?? (map.minX + map.maxX) / 2,
    centerY: center?.y ?? (map.minY + map.maxY) / 2,
    scale: limits.default,
    width,
    height,
  };
}

/** `view` resized to `width` x `height`, keeping its centre and, within the new limits, its scale. */
export function resizeView(view: View, map: Bounds, width: number, height: number): View {
  return clampView({ ...view, width, height }, map, zoomLimits(map, width, height));
}

/** `view` moved by a drag of `dx`, `dy` CSS pixels: the Map follows the pointer. */
export function panBy(view: View, map: Bounds, dx: number, dy: number): View {
  return clampView({ ...view, centerX: view.centerX - dx / view.scale, centerY: view.centerY - dy / view.scale }, map, zoomLimits(map, view.width, view.height));
}

/** `view` centred on `center`. */
export function centerOn(view: View, map: Bounds, center: Point): View {
  return clampView({ ...view, centerX: center.x, centerY: center.y }, map, zoomLimits(map, view.width, view.height));
}

/**
 * `view` zoomed by `factor` (above 1 zooms in) within the limits, keeping the
 * Map point under `at`, a point on the view in CSS pixels, where it is.
 */
export function zoomAt(view: View, map: Bounds, at: Point, factor: number): View {
  const limits = zoomLimits(map, view.width, view.height);
  const scale = Math.min(Math.max(view.scale * factor, limits.min), limits.max);
  const anchor = screenToMap(view, at);
  const centerX = anchor.x - (at.x - view.width / 2) / scale;
  const centerY = anchor.y - (at.y - view.height / 2) / scale;
  return clampView({ ...view, scale, centerX, centerY }, map, limits);
}

/** The part of the Map the view shows, in meters. */
export function viewBounds(view: View): Bounds {
  const halfWidth = view.width / 2 / view.scale;
  const halfHeight = view.height / 2 / view.scale;
  return { minX: view.centerX - halfWidth, minY: view.centerY - halfHeight, maxX: view.centerX + halfWidth, maxY: view.centerY + halfHeight };
}

/**
 * Fixed-size canvas previews of a Map or a Bot, for the lobby and browser
 * screens. The canvas is drawn at the display's pixel ratio, so drawing code
 * works in CSS pixels and stays sharp.
 */

import type { MapFormat1 } from "@positrontanks/ruleset-data";
import { useEffect, useRef } from "react";
import { botBounds, drawBot, type BotParts } from "./bot.js";
import { entryColor } from "./colors.js";
import type { Artwork, Context } from "./context.js";
import { fitView } from "./geometry.js";
import { drawMap, mapBounds } from "./map.js";

export interface CanvasProps {
  /** In CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Draws the whole picture, in CSS pixels, onto a cleared canvas. */
  readonly draw: (ctx: Context, width: number, height: number) => void;
  /** What the picture shows, for assistive technology. */
  readonly label: string;
}

export function Canvas({ width, height, draw, label }: CanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (canvas == null || ctx == null) return;
    const ratio = window.devicePixelRatio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
  });
  return <canvas ref={ref} role="img" aria-label={label} style={{ width, height }} />;
}

/** The whole Map, fitted into a `size` x `size` box keeping its proportions. */
export function MapPreview({ map, size = 240, label = "Map preview" }: { readonly map: MapFormat1; readonly size?: number; readonly label?: string }) {
  const scale = size / Math.max(map.width, map.height);
  const width = Math.round(map.width * scale);
  const height = Math.round(map.height * scale);
  return (
    <Canvas
      width={width}
      height={height}
      label={label}
      draw={(ctx, w, h) => {
        drawMap(ctx, fitView(mapBounds(map), w, h, 1 / scale), map);
      }}
    />
  );
}

/** One Bot, facing up, filling a `size` x `size` box. */
export function BotPreview({
  parts,
  color = entryColor(0),
  size = 120,
  artwork,
  label = `${parts.chassis.name} preview`,
}: {
  readonly parts: BotParts;
  readonly color?: string;
  readonly size?: number;
  readonly artwork?: Artwork;
  readonly label?: string;
}) {
  return (
    <Canvas
      width={size}
      height={size}
      label={label}
      draw={(ctx, w, h) => {
        const view = fitView(botBounds(parts), w, h, 0.1);
        drawBot(ctx, view, { parts, pose: { x: 0, y: 0, heading: 0 }, color }, artwork);
      }}
    />
  );
}

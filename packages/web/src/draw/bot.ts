/**
 * Drawing a Bot on a canvas (frontend spec section 7, Main view): its
 * Chassis shape tinted and outlined in its Entry's color, its Components at
 * their Slots, and its Bot Name as a label below it.
 *
 * A Component is drawn from its Slot along the Slot direction: `length`
 * along it and `width` across it, centred on the Slot (its `visualSize`, or
 * DEFAULT_VISUAL_SIZE when it has none). Motors go under the Chassis, so
 * wheels and tracks show at its sides; everything else goes on top. A part
 * whose artwork resolves to an image is drawn as that image, fitted to the
 * Chassis's bounds or the Component's box; otherwise as a placeholder shape.
 */

import type { Build, Chassis, Component, Slot, VisualSize } from "@positrontanks/ruleset-data";
import { BOUNDARY_COLOR, componentColor, DISABLED_COLOR } from "./colors.js";
import { traceShape, transform, type Artwork, type Context } from "./context.js";
import {
  apply,
  boundsOf,
  corners,
  mapToScreen,
  poseMatrix,
  shapeBounds,
  unionBounds,
  viewMatrix,
  type Bounds,
  type Pose,
  type View,
} from "./geometry.js";

/** The parts a Build names, looked up in a Parts Catalog. */
export interface BotParts {
  readonly chassis: Chassis;
  /** In the Chassis's Slot order; empty Slots are left out. */
  readonly mounted: readonly MountedComponent[];
}

export interface MountedComponent {
  readonly slot: Slot;
  readonly component: Component;
}

/** What a Parts Catalog, or a Ruleset, offers. */
export interface Catalog {
  readonly chassis: readonly Chassis[];
  readonly components: readonly Component[];
}

/** The size drawn for a Slot-mounted Component that has no `visualSize`. */
export const DEFAULT_VISUAL_SIZE: VisualSize = { length: 0.2, width: 0.2 };

/** The Build's parts, or `undefined` if the catalog lacks its Chassis. Slots and Components the catalog lacks are left out. */
export function botParts(catalog: Catalog, build: Build): BotParts | undefined {
  const chassis = catalog.chassis.find((c) => c.id === build.chassis);
  if (chassis === undefined) return undefined;
  const components = new Map(catalog.components.map((c) => [c.id, c]));
  const mounted: MountedComponent[] = [];
  for (const slot of chassis.slots) {
    const id = build.components[slot.id];
    const component = id === undefined ? undefined : components.get(id);
    if (component !== undefined) mounted.push({ slot, component });
  }
  return { chassis, mounted };
}

/** A Component's drawn box in its Slot's frame: from the Slot forward (up) by `length`, `width` wide. */
export function componentBox(component: Component): Bounds {
  const { length, width } = component.visualSize ?? DEFAULT_VISUAL_SIZE;
  return { minX: -width / 2, minY: -length, maxX: width / 2, maxY: 0 };
}

/** Where a Component is drawn: the corners of its box in the Bot frame. */
export function componentCorners(mounted: MountedComponent): ReturnType<typeof corners> {
  const m = poseMatrix({ x: mounted.slot.x, y: mounted.slot.y, heading: mounted.slot.direction });
  return corners(componentBox(mounted.component)).map((p) => apply(m, p));
}

/** Everything drawn for the Bot, in the Bot frame. */
export function botBounds(parts: BotParts): Bounds {
  return unionBounds([shapeBounds(parts.chassis.shape), ...parts.mounted.map((m) => boundsOf(componentCorners(m)))]);
}

/** How far the drawn Bot reaches from its centre, whatever its Heading. */
export function botReach(parts: BotParts): number {
  return Math.max(...corners(botBounds(parts)).map((p) => Math.hypot(p.x, p.y)));
}

export interface DrawnBot {
  readonly parts: BotParts;
  /** Its centre in Map meters and its Heading. */
  readonly pose: Pose;
  /** Its Entry's color. */
  readonly color: string;
  /** The Bot Name, drawn as a label if given. */
  readonly name?: string;
  /** Drawn grey, as a wreck. */
  readonly disabled?: boolean;
}

const LABEL_FONT = "12px system-ui, sans-serif";

export function drawBot(ctx: Context, view: View, bot: DrawnBot, artwork: Artwork = () => undefined): void {
  const px = 1 / view.scale;
  const color = bot.disabled === true ? DISABLED_COLOR : bot.color;
  const { chassis, mounted } = bot.parts;
  const under = mounted.filter((m) => m.component.kind === "motor");
  const over = mounted.filter((m) => m.component.kind !== "motor");

  ctx.save();
  transform(ctx, viewMatrix(view));
  transform(ctx, poseMatrix(bot.pose));
  ctx.lineJoin = "round";
  ctx.lineWidth = px;
  for (const m of under) drawComponent(ctx, m, artwork);

  const image = chassis.artwork === undefined ? undefined : artwork(chassis.artwork);
  if (image === undefined) {
    traceShape(ctx, chassis.shape);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    drawImageIn(ctx, image, shapeBounds(chassis.shape));
    traceShape(ctx, chassis.shape);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * px;
  ctx.stroke();

  ctx.lineWidth = px;
  for (const m of over) drawComponent(ctx, m, artwork);
  ctx.restore();

  if (bot.name !== undefined) {
    const below = mapToScreen(view, { x: bot.pose.x, y: bot.pose.y + botReach(bot.parts) });
    ctx.save();
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(bot.name, below.x, below.y + 3);
    ctx.fillStyle = color;
    ctx.fillText(bot.name, below.x, below.y + 3);
    ctx.restore();
  }
}

function drawComponent(ctx: Context, mounted: MountedComponent, artwork: Artwork): void {
  const { slot, component } = mounted;
  const box = componentBox(component);
  ctx.save();
  transform(ctx, poseMatrix({ x: slot.x, y: slot.y, heading: slot.direction }));
  const image = component.artwork === undefined ? undefined : artwork(component.artwork);
  if (image === undefined) {
    ctx.fillStyle = componentColor(component.kind);
    ctx.strokeStyle = BOUNDARY_COLOR;
    ctx.beginPath();
    ctx.rect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    ctx.fill();
    ctx.stroke();
  } else {
    drawImageIn(ctx, image, box);
  }
  ctx.restore();
}

function drawImageIn(ctx: Context, image: CanvasImageSource, b: Bounds): void {
  ctx.drawImage(image, b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
}

/**
 * Drawing a Scene (frontend spec section 7): the main view, with each Bot
 * in detail, Projectiles and event effects, and the overview, with the whole
 * Map, a dot per Bot (grey for wrecks), no Projectiles, and the main view's
 * area as a rectangle. Destroyed Obstacles are no longer drawn.
 */

import type { MapFormat1 } from "@positrontanks/ruleset-data";
import { botReach, drawBot, type BotParts } from "../draw/bot.js";
import { DISABLED_COLOR, entryColor } from "../draw/colors.js";
import { transform, type Artwork, type Context } from "../draw/context.js";
import { mapToScreen, viewMatrix, type View } from "../draw/geometry.js";
import { drawMap } from "../draw/map.js";
import { viewBounds } from "./camera.js";
import type { Effect, Scene, ViewerReplay } from "./scene.js";

const PROJECTILE_COLOR = "#212121";
const PROJECTILE_RADIUS = 0.08;
const FLASH_COLOR = "#ffd54f";
const BEAM_COLOR = "#ff6e40";
const HIT_COLOR = "#ff9100";
const MISS_COLOR = "#bdbdbd";
const RAM_COLOR = "#fafafa";
const EXPLOSION_COLOR = "#ff6d00";
const VIEW_RECT_COLOR = "#ffffff";
const SELECTED_COLOR = "#ffffff";

/** The Map as it stands in `scene`: without the Obstacles destroyed so far. */
export function mapIn(map: MapFormat1, scene: Scene): MapFormat1 {
  return scene.destroyedObstacles.size === 0 ? map : { ...map, obstacles: map.obstacles.filter((o) => !scene.destroyedObstacles.has(o.id)) };
}

/** Each Bot's name and parts, by Bot id. */
export interface BotLooks {
  readonly name: string;
  /** Undefined when the Parts Catalog lacks its Chassis: it is drawn as a plain disc. */
  readonly parts: BotParts | undefined;
}

/** The main view of `scene`; the Bot `selected`, if any, gets a ring around it. */
export function drawMainView(
  ctx: Context,
  view: View,
  replay: ViewerReplay,
  scene: Scene,
  looks: ReadonlyMap<number, BotLooks>,
  selected?: number,
  artwork?: Artwork,
): void {
  drawMap(ctx, view, mapIn(replay.map, scene), { spawnZones: false });
  // Wrecks first, so live Bots go over them.
  const ordered = [...scene.bots.filter((b) => b.disabled), ...scene.bots.filter((b) => !b.disabled)];
  for (const bot of ordered) {
    const look = looks.get(bot.id);
    const color = entryColor(bot.entry);
    const pose = { x: bot.x, y: bot.y, heading: bot.heading };
    if (look?.parts === undefined) {
      disc(ctx, view, pose, 0.5, bot.disabled ? DISABLED_COLOR : color, 1);
      continue;
    }
    drawBot(ctx, view, { parts: look.parts, pose, color, name: look.name, disabled: bot.disabled }, artwork);
  }
  const chosen = scene.bots.find((b) => b.id === selected);
  if (chosen !== undefined) {
    const parts = looks.get(chosen.id)?.parts;
    const at = mapToScreen(view, chosen);
    ctx.save();
    ctx.strokeStyle = SELECTED_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(at.x, at.y, (parts === undefined ? 0.5 : botReach(parts)) * view.scale + 4, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  transform(ctx, viewMatrix(view));
  ctx.fillStyle = PROJECTILE_COLOR;
  for (const p of scene.projectiles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(PROJECTILE_RADIUS, 2 / view.scale), 0, 2 * Math.PI);
    ctx.fill();
  }
  for (const effect of scene.effects) drawEffect(ctx, effect, 1 / view.scale);
  ctx.restore();
}

function drawEffect(ctx: Context, effect: Effect, px: number): void {
  const fade = 1 - effect.age;
  ctx.globalAlpha = fade;
  switch (effect.kind) {
    case "muzzle":
      ctx.fillStyle = FLASH_COLOR;
      ctx.beginPath();
      ctx.arc(effect.at.x, effect.at.y, Math.max(0.25 * fade, 2 * px), 0, 2 * Math.PI);
      ctx.fill();
      break;
    case "beam":
      ctx.strokeStyle = BEAM_COLOR;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(effect.from.x, effect.from.y);
      ctx.lineTo(effect.to.x, effect.to.y);
      ctx.stroke();
      break;
    case "impact":
      ctx.strokeStyle = effect.hit ? HIT_COLOR : MISS_COLOR;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(effect.at.x, effect.at.y, 0.15 + 0.35 * effect.age, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    case "collision":
      ctx.strokeStyle = RAM_COLOR;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.arc(effect.at.x, effect.at.y, 0.2 + 0.4 * effect.age, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    case "explosion":
      ctx.fillStyle = EXPLOSION_COLOR;
      ctx.globalAlpha = 0.8 * fade;
      ctx.beginPath();
      ctx.arc(effect.at.x, effect.at.y, 0.5 + 1.5 * effect.age, 0, 2 * Math.PI);
      ctx.fill();
      break;
  }
  ctx.globalAlpha = 1;
}

/** A disc of `radius` meters, or at least `minPixels` CSS pixels. */
function disc(ctx: Context, view: View, at: { readonly x: number; readonly y: number }, radius: number, color: string, minPixels: number): void {
  const p = mapToScreen(view, at);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(radius * view.scale, minPixels), 0, 2 * Math.PI);
  ctx.fill();
}

const DOT_PIXELS = 3;

/** The overview: the whole Map in `view`, each Bot as a dot, and the main view's area. */
export function drawOverview(ctx: Context, view: View, replay: ViewerReplay, scene: Scene, mainView: View): void {
  drawMap(ctx, view, mapIn(replay.map, scene), { spawnZones: false });
  for (const bot of [...scene.bots.filter((b) => b.disabled), ...scene.bots.filter((b) => !b.disabled)]) {
    disc(ctx, view, bot, 0, bot.disabled ? DISABLED_COLOR : entryColor(bot.entry), DOT_PIXELS);
  }
  const area = viewBounds(mainView);
  const topLeft = mapToScreen(view, { x: area.minX, y: area.minY });
  const bottomRight = mapToScreen(view, { x: area.maxX, y: area.maxY });
  ctx.save();
  ctx.strokeStyle = VIEW_RECT_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.stroke();
  ctx.restore();
}

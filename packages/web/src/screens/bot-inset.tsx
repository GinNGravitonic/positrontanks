/**
 * The Bot inset (frontend spec section 7, Bot inset): what a Spectator sees
 * of the selected Bot at the current moment of the Game. Its Bot Name,
 * Icon, Player and Emblem; its Chassis, Components by Slot and Armor by side; its
 * Hit Points, speed and status; the damage it has dealt to Foes and taken so
 * far; and a button to follow it. It never shows a Program or Program logs.
 */

import { ARMOR_SIDES } from "@positrontanks/ruleset-data";
import type { Catalog } from "../draw/bot.js";
import { entryColor } from "../draw/colors.js";
import type { BotLooks } from "../viewer/draw-scene.js";
import { botFigures, disabledCauseText } from "../viewer/figures.js";
import { clockText } from "../viewer/playback.js";
import type { Scene, ViewerReplay } from "../viewer/scene.js";
import { Emblem, type EmblemOwner } from "./emblem.js";
import { Icon } from "./icon.js";

export interface BotInsetProps {
  readonly replay: ViewerReplay;
  readonly catalog: Catalog;
  readonly scene: Scene;
  readonly bot: number;
  readonly looks: BotLooks | undefined;
  /** Each Player, by Player id. */
  readonly players: ReadonlyMap<string, EmblemOwner>;
  /** Each Bot's Icon hash, or null for none, by Bot Name. */
  readonly icons: ReadonlyMap<string, string | null>;
  /** Whether the main view is following this Bot. */
  readonly following: boolean;
  readonly onFollow: () => void;
  readonly onStopFollowing: () => void;
  readonly onClose: () => void;
}

/** A figure as shown: whole numbers as they are, others to one decimal place. */
export function figureText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function BotInset({ replay, catalog, scene, bot, looks, players, icons, following, onFollow, onStopFollowing, onClose }: BotInsetProps) {
  const entryIndex = replay.entries.findIndex((entry) => entry.bots.some((b) => b.id === bot));
  const entry = replay.entries[entryIndex];
  const design = entry?.bots.find((b) => b.id === bot);
  const now = scene.bots.find((b) => b.id === bot);
  if (entry === undefined || design === undefined || now === undefined) return null;
  const player = players.get(entry.player) ?? { id: entry.player, username: entry.player, emblem: null };
  const color = entryColor(entryIndex);
  const parts = looks?.parts;
  const maxHitPoints = parts?.chassis.stats.hitPoints;
  const figures = botFigures(replay, bot, scene.time);
  const components = new Map(catalog.components.map((c) => [c.id, c]));
  // In the Chassis's Slot order, when the catalog has it.
  const slotted =
    parts === undefined
      ? Object.entries(design.build.components).map(([slot, id]) => [slot, components.get(id)?.name ?? id] as const)
      : parts.mounted.map(({ slot, component }) => [slot.id, component.name] as const);

  return (
    <aside className="bot-inset" aria-label={`Bot ${design.name}`} style={{ borderColor: color }}>
      <header>
        <Emblem player={player} color={color} />
        <div>
          <h3>
            <Icon icon={icons.get(design.name)} name={design.name} size={20} />
            {design.name}
          </h3>
          <p>{player.username}</p>
        </div>
        <button type="button" className="bot-inset-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <dl>
        <dt>Chassis</dt>
        <dd>{parts?.chassis.name ?? design.build.chassis}</dd>
        <dt>Components</dt>
        <dd>
          {slotted.length === 0 ? (
            "none"
          ) : (
            <ul>
              {slotted.map(([slot, name]) => (
                <li key={slot}>
                  {slot}: {name}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Hit Points</dt>
        <dd>
          {typeof maxHitPoints === "number" ? (
            <>
              <meter min={0} max={maxHitPoints} value={now.hitPoints} />{" "}
              {figureText(now.hitPoints)} / {figureText(maxHitPoints)}
            </>
          ) : (
            figureText(now.hitPoints)
          )}
        </dd>
        <dt>Armor</dt>
        <dd>
          <ul>
            {ARMOR_SIDES.map((side) => {
              const id = design.build.armor[side];
              const armor = id === null ? undefined : components.get(id);
              const value = armor?.stats.armor;
              return (
                <li key={side}>
                  {side}: {id === null ? "none" : `${armor?.name ?? id}${typeof value === "number" ? ` (${figureText(value)})` : ""}`}
                </li>
              );
            })}
          </ul>
        </dd>
        <dt>Speed</dt>
        <dd>{`${now.speed.toFixed(1)} m/s`}</dd>
        <dt>Status</dt>
        <dd>
          {figures.disabled === undefined
            ? "Live"
            : `Disabled at ${clockText(figures.disabled.time, replay.tickRate)}: ${disabledCauseText(figures.disabled.cause)}`}
        </dd>
        <dt>Damage dealt to Foes</dt>
        <dd>{figureText(figures.dealtToFoes)}</dd>
        <dt>Damage taken</dt>
        <dd>{figureText(figures.taken)}</dd>
      </dl>
      {following ? (
        <button type="button" onClick={onStopFollowing}>
          Stop following
        </button>
      ) : (
        <button type="button" disabled={now.disabled} onClick={onFollow}>
          Follow
        </button>
      )}
    </aside>
  );
}

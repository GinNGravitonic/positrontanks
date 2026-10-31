/**
 * A development-only gallery at `/dev/drawing`: the r1 Maps that ship with
 * the repo, every r1 Chassis with each Slot filled, and a scene of named
 * Bots on a Map, for checking the Canvas drawing by eye. It is left out of
 * production builds.
 */

import { validateMap, validateRuleset, type Build, type MapFormat1, type Ruleset } from "@positrontanks/ruleset-data";import duelJson from "@positrontanks/ruleset-data/maps/duel.json";
import fourCornersJson from "@positrontanks/ruleset-data/maps/four-corners.json";
import r1Json from "@positrontanks/ruleset-data/rulesets/r1.json";
import { botParts, drawBot, type BotParts } from "../draw/bot.js";
import { entryColor } from "../draw/colors.js";
import { fitView } from "../draw/geometry.js";
import { drawMap } from "../draw/map.js";
import { BotPreview, Canvas, MapPreview } from "../draw/preview.js";

function loadRuleset(json: unknown): Ruleset {
  const result = validateRuleset(json);
  if (!result.ok) throw new Error("the bundled Ruleset is invalid");
  return result.ruleset;
}

function loadMap(json: unknown): MapFormat1 {
  const result = validateMap(json);
  if (!result.ok) throw new Error("a bundled Map is invalid");
  return result.map;
}

const r1 = loadRuleset(r1Json);
const maps: readonly (readonly [string, MapFormat1])[] = [
  ["duel", loadMap(duelJson)],
  ["four-corners", loadMap(fourCornersJson)],
];

/** Each Slot filled with a Component that fits it, turning through the fitting ones so the gallery shows variety. */
function fullBuild(ruleset: Ruleset, chassisIndex: number): Build {
  const chassis = ruleset.chassis[chassisIndex];
  if (chassis === undefined) throw new RangeError("no such Chassis");
  const components: Record<string, string> = {};
  chassis.slots.forEach((slot, i) => {
    const fitting = ruleset.components.filter((c) => c.slotTypes.includes(slot.type));
    const pick = fitting[(chassisIndex + i) % fitting.length];
    if (pick !== undefined) components[slot.id] = pick.id;
  });
  return { chassis: chassis.id, components, armor: { front: null, left: null, right: null, rear: null } };
}

const bots: readonly BotParts[] = r1.chassis.map((_, i) => {
  const parts = botParts(r1, fullBuild(r1, i));
  if (parts === undefined) throw new Error("unknown Chassis");
  return parts;
});

export default function DrawingGallery() {
  const [, duel] = maps[0] ?? [];
  return (
    <>
      <h2>Drawing gallery</h2>
      <h3>Maps</h3>
      <div className="gallery">
        {maps.map(([name, map]) => (
          <figure key={name}>
            <MapPreview map={map} label={name} />
            <figcaption>{name}</figcaption>
          </figure>
        ))}
      </div>
      <h3>Chassis, every Slot filled</h3>
      <div className="gallery">
        {bots.map((parts, i) => (
          <figure key={parts.chassis.id}>
            <BotPreview parts={parts} color={entryColor(i)} />
            <figcaption>
              {parts.chassis.name}: {parts.mounted.map((m) => `${m.slot.id} ${m.component.id}`).join(", ")}
            </figcaption>
          </figure>
        ))}
      </div>
      {duel !== undefined && (
        <>
          <h3>Scene: named Bots on duel, about 15 m across</h3>
          <Canvas
            width={480}
            height={360}
            label="Bots on the duel Map"
            draw={(ctx, w, h) => {
              const view = { ...fitView({ minX: 0, minY: 0, maxX: 20, maxY: 15 }, w, h), centerX: 10, centerY: duel.height / 2 };
              drawMap(ctx, view, duel);
              bots.forEach((parts, i) => {
                drawBot(ctx, view, {
                  parts,
                  pose: { x: 3 + i * 3.5, y: duel.height / 2 + (i % 2 === 0 ? -2 : 2), heading: i * 45 },
                  color: entryColor(i),
                  name: `${parts.chassis.name} ${String(i + 1)}`,
                  disabled: i === bots.length - 1,
                });
              });
            }}
          />
        </>
      )}
    </>
  );
}

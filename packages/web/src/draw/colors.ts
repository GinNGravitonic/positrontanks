/**
 * Drawing colors. Each Entry gets a color from a fixed palette in Entry order
 * (frontend spec section 7, Entry colors). Terrains are colored by name; a
 * Terrain this client does not know gets a muted color derived from its name,
 * so a new Ruleset's Maps still draw.
 */

export const ENTRY_COLORS: readonly string[] = [
  "#e53935",
  "#1e88e5",
  "#43a047",
  "#fdd835",
  "#8e24aa",
  "#fb8c00",
  "#00acc1",
  "#d81b60",
];

/** The color of the Entry at `index` in Entry order, reusing the palette past its end. */
export function entryColor(index: number): string {
  return ENTRY_COLORS[((index % ENTRY_COLORS.length) + ENTRY_COLORS.length) % ENTRY_COLORS.length] ?? "#888888";
}

const TERRAIN_COLORS: Readonly<Record<string, string>> = {
  grass: "#8fb565",
  road: "#a3a3a3",
  sand: "#e3d2a2",
  mud: "#8a6d50",
  ice: "#cde9f5",
};

export function terrainColor(name: string): string {
  const known = TERRAIN_COLORS[name];
  if (known !== undefined) return known;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${String(hash)} 25% 60%)`;
}

export const OBSTACLE_COLOR = "#4a4a4a";
export const DESTRUCTIBLE_COLOR = "#8d6e4f";
export const BOUNDARY_COLOR = "#222222";
export const DISABLED_COLOR = "#8a8a8a";

/** Placeholder fills for Components, by kind. */
export function componentColor(kind: string): string {
  switch (kind) {
    case "weapon":
      return "#3d3d3d";
    case "sensor":
      return "#5f7d8c";
    case "motor":
      return "#262626";
    default:
      return "#9a9a9a";
  }
}

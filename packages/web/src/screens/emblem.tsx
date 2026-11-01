/**
 * A Player's Emblem (frontend spec section 8), wherever one appears: their
 * own image when they have one and it loads, otherwise a placeholder, their
 * initials on a disc in their Entry's color.
 */

import type { Schema } from "../api/client.js";
import { Canvas } from "../draw/preview.js";
import { useImage } from "../hooks.js";
import { emblemPath } from "../images.js";

/** The Player an Emblem is for, as any Player reference in the API gives them. */
export type EmblemOwner = Pick<Schema<"GamePlayer">, "id" | "username" | "emblem">;

/**
 * Up to two initials of a Player's username: the first letters of its first
 * two words, words being split at anything but letters and digits and where
 * a lowercase letter meets an uppercase one; one letter for a single word.
 */
export function initials(username: string): string {
  const words = username
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  return words
    .slice(0, 2)
    .map((word) => String.fromCodePoint(word.codePointAt(0) ?? 0))
    .join("")
    .toUpperCase();
}

/** Black or white, whichever reads better on `color`, a `#rrggbb` color. */
export function textColorOn(color: string): string {
  const channel = (i: number) => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Black wins above the luminance where both contrast ratios are equal.
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

/** The Player's Emblem image once loaded, starting the load if needed; undefined while loading or when there is none to draw. */
export function useEmblem({ id, emblem }: Pick<EmblemOwner, "id" | "emblem">): ImageBitmap | undefined {
  return useImage(emblem === null ? undefined : emblemPath(id, emblem));
}

export function Emblem({ player, color, size = 32 }: { readonly player: EmblemOwner; readonly color: string; readonly size?: number }) {
  const image = useEmblem(player);
  const label = `${player.username}'s Emblem`;
  if (image !== undefined) {
    return (
      <Canvas
        className="emblem"
        width={size}
        height={size}
        label={label}
        draw={(ctx, width, height) => {
          ctx.drawImage(image, 0, 0, width, height);
        }}
      />
    );
  }
  return (
    <svg className="emblem" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={label}>
      <circle cx={16} cy={16} r={16} fill={color} />
      <text x={16} y={16} dy="0.35em" textAnchor="middle" fontSize={14} fontWeight="bold" fill={textColorOn(color)}>
        {initials(player.username)}
      </text>
    </svg>
  );
}

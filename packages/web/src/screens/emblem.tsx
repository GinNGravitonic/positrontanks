/**
 * The placeholder Emblem (frontend spec section 8): Emblems do not exist yet,
 * so a Player's is drawn as their initials on a disc in their Entry's color,
 * wherever an Emblem appears.
 */

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

export function Emblem({ username, color, size = 32 }: { readonly username: string; readonly color: string; readonly size?: number }) {
  return (
    <svg className="emblem" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={`${username}'s Emblem`}>
      <circle cx={16} cy={16} r={16} fill={color} />
      <text x={16} y={16} dy="0.35em" textAnchor="middle" fontSize={14} fontWeight="bold" fill={textColorOn(color)}>
        {initials(username)}
      </text>
    </svg>
  );
}

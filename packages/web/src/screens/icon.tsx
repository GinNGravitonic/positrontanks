/**
 * A Bot Design's Icon (frontend spec section 8), wherever one appears: the
 * design's image once it loads. A design with no Icon, or one that cannot be
 * fetched, such as one taken down (404), draws nothing; there is no
 * placeholder.
 */

import { Canvas } from "../draw/preview.js";
import { useImage } from "../hooks.js";
import { iconPath } from "../images.js";

export interface IconProps {
  /** The `icon` hash of a Bot Design or a Game Entry's Bot; null or absent when it has none. */
  readonly icon: string | null | undefined;
  /** Whose Icon it is: the design's name, or the Bot Name. */
  readonly name: string;
  readonly size?: number;
}

export function Icon({ icon, name, size = 24 }: IconProps) {
  const image = useImage(icon == null ? undefined : iconPath(icon));
  if (image === undefined) return null;
  return (
    <Canvas
      className="icon"
      width={size}
      height={size}
      label={`${name}'s Icon`}
      draw={(ctx, width, height) => {
        ctx.drawImage(image, 0, 0, width, height);
      }}
    />
  );
}

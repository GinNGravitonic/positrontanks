/**
 * Player Emblems and Bot Design Icons (frontend spec section 8), fetched
 * with the session token (`GET /players/{playerId}/emblem/{hash}`,
 * `GET /icons/{hash}`), decoded to an ImageBitmap and kept for the rest of
 * the page, by path: an image never changes for a given hash. One that
 * cannot be fetched or decoded, such as one taken down since (404), is
 * nothing to draw.
 */

import { ApiError, type ApiClient } from "./api/client.js";

/** Decodes a fetched image; `createImageBitmap` in the browser. */
export type DecodeImage = (image: Blob) => Promise<ImageBitmap>;

/** A loaded image, or null when there is none to draw. */
export type LoadedImage = ImageBitmap | null;

/** Where a Player's Emblem with `hash` is fetched from. */
export const emblemPath = (playerId: string, hash: string) => `/players/${encodeURIComponent(playerId)}/emblem/${encodeURIComponent(hash)}`;

/** Where the Icon with `hash` is fetched from. */
export const iconPath = (hash: string) => `/icons/${encodeURIComponent(hash)}`;

export class ImageCache {
  private readonly loads = new Map<string, Promise<LoadedImage>>();
  private readonly loaded = new Map<string, LoadedImage>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<ApiClient, "image">,
    private readonly decode: DecodeImage,
  ) {}

  /** The image at `path`, once loaded; undefined while it is loading or not yet asked for. */
  get(path: string): LoadedImage | undefined {
    return this.loaded.get(path);
  }

  /**
   * Loads the image at `path` once per page; asking again gives the same
   * load. A failure is kept too, except when the server could not be
   * reached: that one is tried again the next time it is asked for.
   */
  load(path: string): Promise<LoadedImage> {
    const existing = this.loads.get(path);
    if (existing !== undefined) return existing;
    const loading = this.api
      .image(path)
      .then(this.decode)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 0) this.loads.delete(path);
        return null;
      })
      .then((image) => {
        if (image !== null || this.loads.has(path)) {
          this.loaded.set(path, image);
          this.emit();
        }
        return image;
      });
    this.loads.set(path, loading);
    return loading;
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

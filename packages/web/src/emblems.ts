/**
 * Player Emblems (frontend spec section 8), fetched with the session token
 * (`GET /players/{playerId}/emblem/{hash}`), decoded to an ImageBitmap and
 * kept for the rest of the page, by Player and hash: an Emblem never changes
 * for a given hash. A Player whose Emblem cannot be fetched or decoded, such
 * as one taken down since (404), is drawn with the placeholder instead.
 */

import { ApiError, type ApiClient } from "./api/client.js";

/** Decodes a fetched image; `createImageBitmap` in the browser. */
export type DecodeImage = (image: Blob) => Promise<ImageBitmap>;

/** A loaded Emblem, or null when there is none to draw. */
export type EmblemImage = ImageBitmap | null;

export class EmblemCache {
  private readonly loads = new Map<string, Promise<EmblemImage>>();
  private readonly loaded = new Map<string, EmblemImage>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<ApiClient, "image">,
    private readonly decode: DecodeImage,
  ) {}

  /** The Emblem, once loaded; undefined while it is loading or not yet asked for. */
  get(playerId: string, hash: string): EmblemImage | undefined {
    return this.loaded.get(key(playerId, hash));
  }

  /**
   * Loads the Emblem once per page; asking again gives the same load. A
   * failure is kept too, except when the server could not be reached: that
   * one is tried again the next time it is asked for.
   */
  load(playerId: string, hash: string): Promise<EmblemImage> {
    const k = key(playerId, hash);
    const existing = this.loads.get(k);
    if (existing !== undefined) return existing;
    const loading = this.api
      .image(`/players/${encodeURIComponent(playerId)}/emblem/${encodeURIComponent(hash)}`)
      .then(this.decode)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 0) this.loads.delete(k);
        return null;
      })
      .then((image) => {
        if (image !== null || this.loads.has(k)) {
          this.loaded.set(k, image);
          this.emit();
        }
        return image;
      });
    this.loads.set(k, loading);
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

const key = (playerId: string, hash: string) => `${playerId}/${hash}`;

/**
 * The signed-in session, kept in `localStorage` (frontend spec section 4).
 * Sessions last 24 hours and are not refreshed; a stored session past its
 * `expiresAt` is dropped when read, and the server's 401 ends one early.
 */

import type { Schema } from "./api/client.js";

export type Session = Schema<"Session">;

export const SESSION_STORAGE_KEY = "positrontanks.session";

/** The part of `Storage` the store uses. */
export type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class SessionStore {
  private session: Session | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: SessionStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.session = readStored(storage);
  }

  /** The current session, or undefined when signed out or expired. */
  current = (): Session | undefined => {
    if (this.session !== undefined && Date.parse(this.session.expiresAt) <= this.now()) this.clear();
    return this.session;
  };

  token = (): string | undefined => this.current()?.token;

  set(session: Session): void {
    this.session = session;
    try {
      this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage full or blocked: the session still lasts for this page.
    }
    this.emit();
  }

  clear(): void {
    if (this.session === undefined) return;
    this.session = undefined;
    try {
      this.storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Nothing more to do.
    }
    this.emit();
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

function readStored(storage: SessionStorage): Session | undefined {
  try {
    const text = storage.getItem(SESSION_STORAGE_KEY);
    if (text === null) return undefined;
    const value = JSON.parse(text) as Partial<Session> | null;
    if (typeof value?.token !== "string" || typeof value.expiresAt !== "string" || typeof value.player?.username !== "string") {
      return undefined;
    }
    return value as Session;
  } catch {
    return undefined;
  }
}

/**
 * Queries for Players and their credentials: password credentials, session
 * tokens and API keys.
 *
 * A Player row is the identity only. Each way of signing in has its own
 * table pointing at it (`password_credentials` in v1), so another sign-in
 * method such as OAuth is a new table, not a change to Players.
 *
 * Tokens arrive here already hashed; this module never sees a raw session
 * token or API key. Times are passed in so callers (and tests) control the
 * clock, and are stored as ISO 8601 UTC strings, which sort chronologically.
 */

import type { DatabaseSync } from "node:sqlite";

/** How other records refer to a Player: enough to show who it is. */
export interface PlayerRef {
  readonly id: string;
  readonly username: string;
  /** The content hash of the Player's current Emblem, or null if it has none. */
  readonly emblem: string | null;
}

export interface PlayerRecord extends PlayerRef {
  readonly createdAt: string;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  /** The start of the key, shown so a Player can tell keys apart. */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface NewApiKey {
  readonly id: string;
  readonly playerId: string;
  readonly name: string;
  readonly prefix: string;
  readonly tokenHash: string;
}

interface PlayerRow {
  id: string;
  username: string;
  emblem: string | null;
  created_at: string;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

const toPlayer = (row: PlayerRow): PlayerRecord => ({
  id: row.id,
  username: row.username,
  emblem: row.emblem,
  createdAt: row.created_at,
});

const toApiKey = (row: ApiKeyRow): ApiKeyRecord => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** The key usernames are unique under: case-insensitive (usernames are ASCII). */
export const usernameKey = (username: string): string => username.toLowerCase();

export class AccountStore {
  readonly #db: DatabaseSync;
  readonly #transaction: <T>(fn: () => T) => T;

  constructor(db: DatabaseSync, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  /** Creates a Player with a password credential, or returns undefined if the username is taken. */
  createPasswordPlayer(id: string, username: string, passwordHash: string, now: Date): PlayerRecord | undefined {
    const at = now.toISOString();
    return this.#transaction(() => {
      const key = usernameKey(username);
      if (this.#db.prepare("SELECT 1 FROM players WHERE username_key = ?").get(key) !== undefined) return undefined;
      this.#db
        .prepare("INSERT INTO players (id, username, username_key, created_at) VALUES (?, ?, ?, ?)")
        .run(id, username, key, at);
      this.#db
        .prepare("INSERT INTO password_credentials (player_id, password_hash, updated_at) VALUES (?, ?, ?)")
        .run(id, passwordHash, at);
      return { id, username, emblem: null, createdAt: at };
    });
  }

  /** The Player with this username (any case) and its password hash, if it has a password. */
  findPasswordCredential(username: string): { player: PlayerRecord; passwordHash: string } | undefined {
    const row = this.#db
      .prepare(
        `SELECT p.id, p.username, p.emblem, p.created_at, c.password_hash
         FROM players p JOIN password_credentials c ON c.player_id = p.id
         WHERE p.username_key = ?`,
      )
      .get(usernameKey(username)) as (PlayerRow & { password_hash: string }) | undefined;
    return row === undefined ? undefined : { player: toPlayer(row), passwordHash: row.password_hash };
  }

  getPlayer(id: string): PlayerRecord | undefined {
    const row = this.#db.prepare("SELECT id, username, emblem, created_at FROM players WHERE id = ?").get(id) as
      | PlayerRow
      | undefined;
    return row === undefined ? undefined : toPlayer(row);
  }

  /**
   * Sets or clears the Player's Emblem and returns the hash it replaced (null
   * if it had none), so the caller can delete the old stored image.
   */
  setEmblem(playerId: string, emblem: string | null): string | null {
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT emblem FROM players WHERE id = ?").get(playerId) as
        | { emblem: string | null }
        | undefined;
      this.#db.prepare("UPDATE players SET emblem = ? WHERE id = ?").run(emblem, playerId);
      return row?.emblem ?? null;
    });
  }

  createSession(tokenHash: string, playerId: string, now: Date, expiresAt: Date): void {
    this.#db
      .prepare("INSERT INTO sessions (token_hash, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, playerId, now.toISOString(), expiresAt.toISOString());
  }

  /** The Player owning an unexpired session with this token hash. */
  findSessionPlayer(tokenHash: string, now: Date): PlayerRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT p.id, p.username, p.emblem, p.created_at
         FROM sessions s JOIN players p ON p.id = s.player_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now.toISOString()) as PlayerRow | undefined;
    return row === undefined ? undefined : toPlayer(row);
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Removes sessions that expired at or before `now`; returns how many. */
  deleteExpiredSessions(now: Date): number {
    const result = this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    return Number(result.changes);
  }

  createApiKey(key: NewApiKey, now: Date): ApiKeyRecord {
    const at = now.toISOString();
    this.#db
      .prepare(
        "INSERT INTO api_keys (id, player_id, name, prefix, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(key.id, key.playerId, key.name, key.prefix, key.tokenHash, at);
    return { id: key.id, name: key.name, prefix: key.prefix, createdAt: at, lastUsedAt: null };
  }

  /** The Player's unrevoked API keys, oldest first. */
  listApiKeys(playerId: string): ApiKeyRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, name, prefix, created_at, last_used_at FROM api_keys
         WHERE player_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid`,
      )
      .all(playerId) as unknown as ApiKeyRow[];
    return rows.map(toApiKey);
  }

  /** Finds the Player owning an unrevoked API key with this hash and records the use. */
  useApiKey(tokenHash: string, now: Date): { player: PlayerRecord; keyId: string } | undefined {
    const row = this.#db
      .prepare(
        `SELECT k.id AS key_id, p.id, p.username, p.emblem, p.created_at
         FROM api_keys k JOIN players p ON p.id = k.player_id
         WHERE k.token_hash = ? AND k.revoked_at IS NULL`,
      )
      .get(tokenHash) as (PlayerRow & { key_id: string }) | undefined;
    if (row === undefined) return undefined;
    this.#db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.key_id);
    return { player: toPlayer(row), keyId: row.key_id };
  }

  /** Revokes one of the Player's keys; false if it has no such unrevoked key. */
  revokeApiKey(playerId: string, keyId: string, now: Date): boolean {
    const result = this.#db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND player_id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), keyId, playerId);
    return Number(result.changes) > 0;
  }
}

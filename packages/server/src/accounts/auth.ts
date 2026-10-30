/**
 * Request authentication.
 *
 * Every authenticated request carries `Authorization: Bearer <token>`, where
 * the token is either a session token (from logging in) or an API key; the
 * prefix says which. Handlers call `authenticate` and get the Player back, or
 * the request is answered with 401 `unauthorized`.
 */

import type { PlayerRecord } from "../db/accounts.js";
import { ApiError } from "../http/errors.js";
import type { RequestContext } from "../http/router.js";
import { API_KEY_PREFIX, hashToken, SESSION_TOKEN_PREFIX } from "./secrets.js";

/** How long a session token lasts after logging in. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type Credential =
  | { readonly kind: "session"; readonly tokenHash: string }
  | { readonly kind: "apiKey"; readonly keyId: string };

export interface Principal {
  readonly player: PlayerRecord;
  readonly credential: Credential;
}

export const unauthorized = (message: string): ApiError =>
  new ApiError(401, "unauthorized", message, undefined, { "www-authenticate": 'Bearer realm="positrontanks"' });

/** The bearer token in the request, if it has one. */
export function bearerToken(context: RequestContext): string | undefined {
  const header = context.request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** The Player making the request; throws 401 if the request has no valid credential. */
export function authenticate(context: RequestContext, now = new Date()): Principal {
  const token = bearerToken(context);
  if (token === undefined) throw unauthorized("Send a session token or API key as `Authorization: Bearer <token>`");
  const accounts = context.services.db.accounts;
  const tokenHash = hashToken(token);

  if (token.startsWith(SESSION_TOKEN_PREFIX)) {
    const player = accounts.findSessionPlayer(tokenHash, now);
    if (player !== undefined) return { player, credential: { kind: "session", tokenHash } };
    throw unauthorized("The session token is invalid or has expired; log in again");
  }
  if (token.startsWith(API_KEY_PREFIX)) {
    const found = accounts.useApiKey(tokenHash, now);
    if (found !== undefined) return { player: found.player, credential: { kind: "apiKey", keyId: found.keyId } };
    throw unauthorized("The API key is invalid or has been revoked");
  }
  throw unauthorized("The bearer token is not a session token or API key");
}

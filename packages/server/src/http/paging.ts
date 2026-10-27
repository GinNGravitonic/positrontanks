/**
 * The paging convention shared by every list endpoint.
 *
 * Lists take `?limit=N&cursor=...` (limit 1-200, default 50) and keep their
 * wrapper object, adding `nextCursor`: the token for the next page, or null
 * on the last. A cursor is opaque to clients; it encodes the last item's
 * sort value and rowid (see db/paging.ts), base64url JSON.
 */

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, type Page, type PageKey, type PageRequest } from "../db/paging.js";
import { badRequest } from "./errors.js";
import type { Json } from "./router.js";

/** The type of a list's sort value: a timestamp, or a Revision number. */
export type SortType = "string" | "number";

export const pageParameters: readonly Json[] = [
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: PAGE_LIMIT_MAX, default: PAGE_LIMIT_DEFAULT },
    description: "At most this many items.",
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "The `nextCursor` of the previous page; the first page if left out.",
  },
];

export const nextCursorSchema: Json = {
  type: ["string", "null"],
  description: "Pass as `cursor` for the next page; null on the last page.",
};

export function encodeCursor(key: PageKey): string {
  return Buffer.from(JSON.stringify([key.sort, key.rowid])).toString("base64url");
}

function decodeCursor(cursor: string, sortType: SortType): PageKey | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [sort, rowid] = value as unknown[];
  if (typeof sort !== sortType || !Number.isSafeInteger(rowid)) return undefined;
  return { sort: sort as string | number, rowid: rowid as number };
}

/** The page asked for by `limit` and `cursor`; 400 if either is malformed. */
export function readPage(query: URLSearchParams, sortType: SortType): PageRequest {
  const rawLimit = query.get("limit");
  let limit = PAGE_LIMIT_DEFAULT;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > PAGE_LIMIT_MAX) {
      throw badRequest(`limit must be an integer from 1 to ${String(PAGE_LIMIT_MAX)}`);
    }
  }
  const cursor = query.get("cursor");
  if (cursor === null) return { limit };
  const after = decodeCursor(cursor, sortType);
  if (after === undefined) throw badRequest("cursor is not valid; use a nextCursor from this list");
  return { limit, after };
}

/** The `nextCursor` field of a page's response. */
export const nextCursor = (page: Page<unknown>): { nextCursor: string | null } => ({
  nextCursor: page.next === null ? null : encodeCursor(page.next),
});

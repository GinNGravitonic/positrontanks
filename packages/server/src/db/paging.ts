/**
 * Keyset paging for list queries.
 *
 * Every paged list is ordered by one sort column, descending, with the
 * table's rowid as the tie-breaker. A page after a key continues strictly
 * below it in that order, so rows inserted or updated while a client pages
 * cause no gaps or duplicates: at worst an updated row moves above the
 * pages already read.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

/** The position of a row in a paged list: its sort value and rowid. */
export interface PageKey {
  readonly sort: string | number;
  readonly rowid: number;
}

export interface PageRequest {
  /** At most this many items. */
  readonly limit: number;
  /** Start after this row; from the top if left out. */
  readonly after?: PageKey;
}

export interface Page<T> {
  readonly items: T[];
  /** Where the next page starts; null if this is the last. */
  readonly next: PageKey | null;
}

export const FIRST_PAGE: PageRequest = { limit: PAGE_LIMIT_DEFAULT };

export interface PageQuery {
  /** The selected columns and the FROM clause, without SELECT. */
  readonly columns: string;
  readonly conditions: readonly string[];
  readonly args: readonly SQLInputValue[];
  /** The sort column, ordered descending. */
  readonly sort: string;
  /** The rowid of the sorted table, the tie-breaker. */
  readonly rowid: string;
}

interface PageRow {
  readonly page_sort: string | number;
  readonly page_rowid: number;
}

/**
 * Runs `query` for one page, mapping each row (which also carries page_sort
 * and page_rowid) with `map`, which takes the row type the query selects.
 */
export function queryPage<T>(
  db: DatabaseSync,
  query: PageQuery,
  page: PageRequest,
  map: (row: never) => T,
): Page<T> {
  const conditions = [...query.conditions];
  const args = [...query.args];
  if (page.after !== undefined) {
    conditions.push(`(${query.sort} < ? OR (${query.sort} = ? AND ${query.rowid} < ?))`);
    args.push(page.after.sort, page.after.sort, page.after.rowid);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT ${query.sort} AS page_sort, ${query.rowid} AS page_rowid, ${query.columns} ${where}
       ORDER BY ${query.sort} DESC, ${query.rowid} DESC LIMIT ?`,
    )
    .all(...args, page.limit + 1) as unknown as PageRow[];
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  const last = kept.at(-1);
  return {
    items: kept.map((row) => map(row as never)),
    next: more && last !== undefined ? { sort: last.page_sort, rowid: last.page_rowid } : null,
  };
}

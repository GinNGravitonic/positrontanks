/**
 * Serves the built web client under `/play/` (ADR-0006, frontend spec
 * section 2).
 *
 * A path naming a built file is answered with that file; any other `/play/*`
 * path is answered with the client's `index.html`, so client routes can be
 * bookmarked and reloaded. Vite fingerprints everything under `assets/`, so
 * those files are cached for good; everything else is revalidated.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { ApiError, notFound } from "./errors.js";
import type { Reply } from "./router.js";

export const WEB_CLIENT_PATH = "/play";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Whether `pathname` belongs to the web client rather than the API. */
export function isWebClientPath(pathname: string): boolean {
  return pathname === WEB_CLIENT_PATH || pathname.startsWith(`${WEB_CLIENT_PATH}/`);
}

/** Answers a request for a web client path; `directory` holds the built client. */
export async function serveWebClient(directory: string, method: string, url: URL): Promise<Reply> {
  if (method !== "GET" && method !== "HEAD") {
    throw new ApiError(405, "method_not_allowed", `${method} is not allowed here; use GET, HEAD`, undefined, {
      allow: "GET, HEAD",
    });
  }
  // Relative asset URLs only resolve from inside the directory.
  if (url.pathname === WEB_CLIENT_PATH) {
    return { status: 308, headers: { location: `${WEB_CLIENT_PATH}/${url.search}` } };
  }

  const relative = filePath(url.pathname.slice(WEB_CLIENT_PATH.length + 1));
  if (relative !== undefined && relative !== "index.html") {
    const file = await readBuiltFile(join(directory, relative));
    if (file !== undefined) {
      return {
        bytes: { type: CONTENT_TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream", content: file },
        headers: { "cache-control": relative.startsWith("assets/") ? IMMUTABLE : "no-cache" },
      };
    }
  }

  const index = await readBuiltFile(join(directory, "index.html"));
  if (index === undefined) throw notFound("The web client is not built on this server");
  return { bytes: { type: "text/html; charset=utf-8", content: index }, headers: { "cache-control": "no-cache" } };
}

/**
 * The path below the client's directory that `rest` names, or undefined if it
 * cannot name a built file (empty, malformed, or escaping the directory).
 */
function filePath(rest: string): string | undefined {
  if (rest === "") return undefined;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === "" || segment === "." || segment === ".." || /[/\\\0]/.test(segment)) return undefined;
    segments.push(segment);
  }
  return segments.join("/");
}

async function readBuiltFile(path: string): Promise<Uint8Array | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

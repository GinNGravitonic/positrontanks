/**
 * Request body reading: JSON only, size-limited.
 */

import type { IncomingMessage } from "node:http";
import { ApiError, badRequest } from "./errors.js";

/** Reads the body as JSON, rejecting the wrong content type, oversized bodies and invalid JSON. */
export async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Request body must be application/json");
  }

  const tooLarge = (): ApiError =>
    new ApiError(413, "payload_too_large", `Request body exceeds ${String(maxBytes)} bytes`, undefined, {
      connection: "close",
    });
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw badRequest("Request body is empty");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ApiError(400, "invalid_json", `Request body is not valid JSON: ${(error as Error).message}`);
  }
}

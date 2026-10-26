/**
 * Descriptions: the free text an owner keeps on a Bot Design or a Map, and
 * reading the updates (PATCH) that change a name and/or description.
 *
 * Plain text (no markup is interpreted), trimmed, at most
 * DESCRIPTION_MAX_LENGTH characters, and empty when there is none. A
 * description belongs to the design or Map, not to a Revision, so it can be
 * changed at any time without adding one.
 */

import { validationFailed, type ErrorDetail } from "../http/errors.js";
import type { Json } from "../http/router.js";

export const DESCRIPTION_MAX_LENGTH = 2000;

export const descriptionSchema: { readonly [key: string]: Json } = {
  type: "string",
  maxLength: DESCRIPTION_MAX_LENGTH,
  description: `Plain text, trimmed, at most ${String(DESCRIPTION_MAX_LENGTH)} characters; empty if none.`,
};

/** A trimmed description, or undefined after recording a problem. */
export function readDescription(value: unknown, details: ErrorDetail[]): string | undefined {
  if (typeof value !== "string") {
    details.push({ path: "description", message: "must be a string" });
    return undefined;
  }
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    details.push({ path: "description", message: `must be at most ${String(DESCRIPTION_MAX_LENGTH)} characters` });
    return undefined;
  }
  return description;
}

/** A name and/or description to change; fields left out are kept. */
export interface NameAndDescription {
  name?: string;
  description?: string;
}

/**
 * Reads an update body holding `name` and/or `description` (at least one),
 * checking the name with `readName`, and throws 422 listing every problem.
 */
export function readChanges(
  readName: (value: unknown, details: ErrorDetail[]) => string | undefined,
  body: unknown,
): NameAndDescription {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationFailed([{ path: "(body)", message: "must be a JSON object" }]);
  }
  const record = body as Record<string, unknown>;
  const details: ErrorDetail[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "name" && key !== "description") details.push({ path: key, message: "is not a known field" });
  }
  if (record.name === undefined && record.description === undefined) {
    details.push({ path: "(body)", message: "must have a name or a description to change" });
  }
  const changes: NameAndDescription = {};
  if (record.name !== undefined) {
    const name = readName(record.name, details);
    if (name !== undefined) changes.name = name;
  }
  if (record.description !== undefined) {
    const description = readDescription(record.description, details);
    if (description !== undefined) changes.description = description;
  }
  if (details.length > 0) throw validationFailed(details);
  return changes;
}

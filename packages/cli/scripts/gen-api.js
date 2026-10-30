/**
 * Regenerates src/api/openapi.json and src/api/schema.ts from @positrontanks/server
 * (docs/spec/cli-api.md, HTTP client). The server must be built first
 * (`pnpm build`); src/api/openapi.test.ts fails until this is run after the
 * server's API changes.
 */

import { writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { schemaText, serverOpenApiDocument, snapshotText } from "../src/api/generate.ts";

const document = await serverOpenApiDocument();
await writeFile(new URL("../src/api/openapi.json", import.meta.url), snapshotText(document));
await writeFile(new URL("../src/api/schema.ts", import.meta.url), await schemaText(document));

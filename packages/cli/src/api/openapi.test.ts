import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { schemaText, serverOpenApiDocument, snapshotText } from "./generate.js";

const read = (file: string) => readFile(new URL(file, import.meta.url), "utf8");

describe("the committed OpenAPI snapshot", () => {
  it("is the document the server serves, and schema.ts its types (else run: pnpm --filter @positrontanks/cli gen:api)", async () => {
    const document = await serverOpenApiDocument();
    expect(await read("./openapi.json")).toBe(snapshotText(document));
    expect(await read("./schema.ts")).toBe(await schemaText(document));
  });
});

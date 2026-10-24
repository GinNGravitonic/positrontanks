/**
 * Process entry point: `node dist/main.js`. Configured by `AUMOHTA_*`
 * environment variables (see config.ts).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { jsonLogger, startServer } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });

const running = await startServer(config);
jsonLogger.info("Server listening", { url: running.url, database: config.databasePath });

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  jsonLogger.info("Shutting down", { signal });
  running.close().then(
    () => process.exit(0),
    (error: unknown) => {
      jsonLogger.error("Shutdown failed", { error: String(error) });
      process.exit(1);
    },
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

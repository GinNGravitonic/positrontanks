import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { ConfigError, type StorageConfig } from "../config.js";
import { LocalObjectStore } from "./local-object-store.js";
import type { ObjectStore } from "./object-store.js";
import { S3ObjectStore } from "./s3-object-store.js";

/** The ObjectStore the configuration selects. Credentials for S3 come from the AWS SDK's default chain. */
export function createObjectStore(config: StorageConfig): ObjectStore {
  switch (config.kind) {
    case "local":
      return new LocalObjectStore(config.directory);
    case "s3": {
      const client = new S3Client({
        ...(config.region === undefined ? {} : { region: config.region }),
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
      });
      return new S3ObjectStore({ client, bucket: config.bucket, keyPrefix: config.keyPrefix });
    }
  }
}

/**
 * Creates the local storage directory and probes a write there, so an unusable
 * POSITRONTANKS_STORAGE_DIRECTORY fails at startup with a ConfigError instead
 * of when the first Replay is stored. Does nothing for S3.
 */
export async function checkObjectStorage(config: StorageConfig): Promise<void> {
  if (config.kind !== "local") return;
  const directory = resolve(config.directory);
  // A `.tmp-` name, like LocalObjectStore's own temporary files, so list() never reports it.
  const probe = join(directory, `.tmp-probe-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "");
    await rm(probe);
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([`POSITRONTANKS_STORAGE_DIRECTORY "${directory}" cannot be created or written: ${reason}`]);
  }
}

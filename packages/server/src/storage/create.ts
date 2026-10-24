import { S3Client } from "@aws-sdk/client-s3";
import type { StorageConfig } from "../config.js";
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

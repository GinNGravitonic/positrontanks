/**
 * ObjectStore backed by an S3 bucket. An optional key prefix lets several
 * uses share one bucket (for example `objects/` beside Litestream's
 * replica).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertValidKey, assertValidPrefix, type ObjectStore } from "./object-store.js";

export interface S3ObjectStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  /** Prepended to every key; empty or ending in `/`. */
  readonly keyPrefix?: string;
}

/** True for the SDK's "no such object" errors (GetObject's NoSuchKey, HeadObject's bare 404). */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(options: S3ObjectStoreOptions) {
    const keyPrefix = options.keyPrefix ?? "";
    if (keyPrefix !== "" && !keyPrefix.endsWith("/")) {
      throw new Error(`S3 key prefix must be empty or end with "/", got ${JSON.stringify(keyPrefix)}`);
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = keyPrefix;
  }

  private objectKey(key: string): string {
    assertValidKey(key);
    return this.keyPrefix + key;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: body }));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      if (output.Body === undefined) return new Uint8Array();
      return await output.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 deletes are already idempotent.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async list(prefix = ""): Promise<string[]> {
    assertValidPrefix(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.keyPrefix + prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key.slice(this.keyPrefix.length));
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys.sort();
  }
}

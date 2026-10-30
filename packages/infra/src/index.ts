/**
 * Pulumi program entry point (Pulumi.yaml `main: dist/index.js`): reads the
 * stack configuration and creates the deployment (stack.ts). See
 * docs/deployment.md.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pulumi from "@pulumi/pulumi";
import { createStack } from "./stack.js";

const config = new pulumi.Config();
const domainName = config.get("domainName");
const hostedZoneId = config.get("hostedZoneId");
if ((domainName === undefined) !== (hostedZoneId === undefined)) {
  throw new Error("positrontanks:domainName and positrontanks:hostedZoneId must be set together");
}

const stack = createStack("positrontanks", {
  buildContext: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  cpu: config.getNumber("cpu") ?? 512,
  memoryMiB: config.getNumber("memoryMiB") ?? 1024,
  domain: domainName === undefined || hostedZoneId === undefined ? undefined : { name: domainName, hostedZoneId },
  environment: config.getObject<Record<string, string>>("environment") ?? {},
  secretEnvironment: config.getSecretObject<Record<string, string>>("secretEnvironment") ?? {},
  logRetentionDays: config.getNumber("logRetentionDays") ?? 30,
});

export const url = stack.url;
export const loadBalancerDnsName = stack.loadBalancerDnsName;
export const objectsBucket = stack.objectsBucket;
export const litestreamBucket = stack.litestreamBucket;
export const repositoryUrl = stack.repositoryUrl;
export const clusterName = stack.clusterName;
export const serviceName = stack.serviceName;

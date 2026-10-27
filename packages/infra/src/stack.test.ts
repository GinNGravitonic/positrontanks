import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { ALB_IDLE_TIMEOUT_SECONDS, createStack, type StackArgs, STOP_TIMEOUT_SECONDS } from "./stack.js";

interface Registered {
  readonly type: string;
  readonly name: string;
  readonly inputs: Record<string, unknown>;
}

const registered: Registered[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        const inputs = args.inputs as Record<string, unknown>;
        registered.push({ type: args.type, name: args.name, inputs });
        return {
          id: `${args.name}-id`,
          state: {
            ...inputs,
            arn: `arn:aws:mock:::${args.name}`,
            name: inputs.name ?? args.name,
            bucket: inputs.bucket ?? `${args.name}-bucket`,
            dnsName: `${args.name}.elb.example`,
            repositoryUrl: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${args.name}`,
            ref: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${args.name}@sha256:0`,
          },
        };
      },
      call: (args) => {
        switch (args.token) {
          case "aws:index/getRegion:getRegion":
            return { name: "us-east-1", region: "us-east-1" };
          case "aws:index/getAvailabilityZones:getAvailabilityZones":
            return { names: ["us-east-1a", "us-east-1b"] };
          case "aws:ecr/getAuthorizationToken:getAuthorizationToken":
            return { userName: "AWS", password: "token" };
          default:
            return {};
        }
      },
    },
    "aumohta",
    "test",
    true,
  );
});

const baseArgs: StackArgs = {
  buildContext: ".",
  cpu: 512,
  memoryMiB: 1024,
  environment: {},
  secretEnvironment: {},
  logRetentionDays: 30,
};

/** Each test uses its own stack name, so late registrations from another test don't leak in. */
function ofStack(name: string, type: string): Registered[] {
  return registered.filter((resource) => resource.type === type && resource.name.startsWith(name));
}

function only(name: string, type: string): Registered {
  const matches = ofStack(name, type);
  expect(matches).toHaveLength(1);
  return matches[0] as Registered;
}

function resolved<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

describe("createStack", () => {
  it("runs at most one task and stops it before starting a replacement (ADR-0003)", async () => {
    const stack = createStack("single", {
      ...baseArgs,
      environment: { AUMOHTA_MAX_UNTHROTTLED_GAMES: "2" },
      secretEnvironment: { AUMOHTA_EXAMPLE_SECRET: "hunter2" },
    });
    await resolved(stack.serviceName);

    const service = only("single", "aws:ecs/service:Service").inputs;
    expect(service.desiredCount).toBe(1);
    expect(service.deploymentMinimumHealthyPercent).toBe(0);
    expect(service.deploymentMaximumPercent).toBe(100);
  });

  it("gives Litestream time for its final sync and configures S3 storage", async () => {
    const stack = createStack("litestream", {
      ...baseArgs,
      environment: { AUMOHTA_MAX_UNTHROTTLED_GAMES: "2" },
      secretEnvironment: { AUMOHTA_EXAMPLE_SECRET: "hunter2" },
    });
    await resolved(stack.serviceName);

    const taskDefinition = only("litestream", "aws:ecs/taskDefinition:TaskDefinition").inputs;
    const [container] = JSON.parse(taskDefinition.containerDefinitions as string) as {
      stopTimeout: number;
      environment: { name: string; value: string }[];
      secrets: { name: string; valueFrom: string }[];
    }[];
    expect(STOP_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(30);
    expect(container?.stopTimeout).toBe(STOP_TIMEOUT_SECONDS);

    const environment = Object.fromEntries((container?.environment ?? []).map((v) => [v.name, v.value]));
    expect(environment).toMatchObject({
      AUMOHTA_STORAGE: "s3",
      AUMOHTA_S3_BUCKET: "litestream-objects-bucket",
      AUMOHTA_LITESTREAM_REPLICA_URL: "s3://litestream-litestream-bucket/aumohta",
      AUMOHTA_MAX_UNTHROTTLED_GAMES: "2",
    });
    // A local-server feature; shared deployments leave it off (docs/docker.md).
    expect(environment).not.toHaveProperty("AUMOHTA_TICK_COST_CHECK");
    expect(container?.secrets).toEqual([
      { name: "AUMOHTA_EXAMPLE_SECRET", valueFrom: "arn:aws:mock:::litestream:AUMOHTA_EXAMPLE_SECRET::" },
    ]);
    expect(taskDefinition.containerDefinitions).not.toContain("hunter2");
  });

  it("keeps SSE Game streams open through the load balancer", async () => {
    const stack = createStack("sse", {
      ...baseArgs,
    });
    await resolved(stack.url);

    expect(ALB_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(15);
    expect(only("sse", "aws:lb/loadBalancer:LoadBalancer").inputs.idleTimeout).toBe(ALB_IDLE_TIMEOUT_SECONDS);
    expect(await resolved(stack.url)).toBe("http://sse.elb.example");
  });

  it("serves HTTPS with a redirect from HTTP when given a domain", async () => {
    const stack = createStack("https", {
      ...baseArgs,
      domain: { name: "aumohta.example.com", hostedZoneId: "Z123" },
    });
    await resolved(stack.serviceName);

    const listeners = ofStack("https", "aws:lb/listener:Listener");
    expect(listeners.map((listener) => listener.inputs.port as number).toSorted((a, b) => a - b)).toEqual([80, 443]);
    expect(await resolved(stack.url)).toBe("https://aumohta.example.com");
  });
});

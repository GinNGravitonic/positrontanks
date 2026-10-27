/**
 * The Aumohta AWS deployment (ADR-0003, docs/docker.md): one Fargate task
 * running the server image behind an ALB, with S3 buckets for object storage
 * and for Litestream's replica of the SQLite database.
 *
 * Exactly one task may run against the database, so the service is pinned to
 * a single task and deploys stop the old task before starting the new one
 * (minimum healthy 0 %, maximum 100 %), at the cost of brief downtime. The new
 * task restores the database from the Litestream replica on boot.
 */

import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as pulumi from "@pulumi/pulumi";

export interface StackArgs {
  /** Docker build context: the repository root. */
  readonly buildContext: string;
  /** Fargate task size; see the valid CPU/memory combinations in the ECS docs. */
  readonly cpu: number;
  readonly memoryMiB: number;
  /**
   * Serve HTTPS on this domain name, with an ACM certificate validated through
   * (and an alias record in) the given Route 53 hosted zone. Without it the
   * ALB serves plain HTTP on its own DNS name.
   */
  readonly domain?: { readonly name: string; readonly hostedZoneId: string } | undefined;
  /** Extra plain `AUMOHTA_*` variables, e.g. limits. */
  readonly environment: Readonly<Record<string, string>>;
  /** Variables stored in Secrets Manager and injected by ECS. */
  readonly secretEnvironment: pulumi.Input<Readonly<Record<string, string>>>;
  readonly logRetentionDays: number;
}

export interface StackOutputs {
  readonly url: pulumi.Output<string>;
  readonly loadBalancerDnsName: pulumi.Output<string>;
  readonly objectsBucket: pulumi.Output<string>;
  readonly litestreamBucket: pulumi.Output<string>;
  readonly repositoryUrl: pulumi.Output<string>;
  readonly clusterName: pulumi.Output<string>;
  readonly serviceName: pulumi.Output<string>;
}

const CONTAINER_NAME = "server";
const CONTAINER_PORT = 8080;
/**
 * Litestream retries its final sync for up to 30 s after SIGTERM
 * (docs/docker.md); ECS kills the container when this runs out.
 */
export const STOP_TIMEOUT_SECONDS = 40;
/** Comfortably above the server's 15 s SSE heartbeat, so Game streams stay open. */
export const ALB_IDLE_TIMEOUT_SECONDS = 120;
/**
 * A restore from the replica runs before the server listens; don't let ALB
 * health checks kill the task meanwhile.
 */
const HEALTH_CHECK_GRACE_SECONDS = 180;

export function createStack(name: string, args: StackArgs): StackOutputs {
  const region = aws.getRegionOutput().region;
  const zones = aws.getAvailabilityZonesOutput({ state: "available" }).names;

  // --- Network: a VPC with two public subnets (the ALB needs two AZs). The
  // task gets a public IP for ECR, S3 and CloudWatch, so no NAT gateway.
  const vpc = new aws.ec2.Vpc(name, {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: name },
  });
  const gateway = new aws.ec2.InternetGateway(name, { vpcId: vpc.id, tags: { Name: name } });
  const routeTable = new aws.ec2.RouteTable(name, {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: gateway.id }],
    tags: { Name: name },
  });
  const subnets = [0, 1].map((i) => {
    const subnet = new aws.ec2.Subnet(`${name}-public-${String(i)}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${String(i)}.0/24`,
      availabilityZone: zones.apply((names) => {
        const zone = names[i];
        if (zone === undefined) throw new Error(`region has fewer than two available zones`);
        return zone;
      }),
      mapPublicIpOnLaunch: true,
      tags: { Name: `${name}-public-${String(i)}` },
    });
    new aws.ec2.RouteTableAssociation(`${name}-public-${String(i)}`, {
      subnetId: subnet.id,
      routeTableId: routeTable.id,
    });
    return subnet;
  });
  const subnetIds = subnets.map((subnet) => subnet.id);

  const albSecurityGroup = new aws.ec2.SecurityGroup(`${name}-alb`, {
    vpcId: vpc.id,
    description: "Aumohta load balancer",
    ingress: [
      { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
      { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  });
  const taskSecurityGroup = new aws.ec2.SecurityGroup(`${name}-task`, {
    vpcId: vpc.id,
    description: "Aumohta server task",
    ingress: [
      { protocol: "tcp", fromPort: CONTAINER_PORT, toPort: CONTAINER_PORT, securityGroups: [albSecurityGroup.id] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
  });

  // --- Storage: object storage and the Litestream replica, both private.
  const privateBucket = (suffix: string): aws.s3.Bucket => {
    const bucket = new aws.s3.Bucket(`${name}-${suffix}`, {});
    new aws.s3.BucketPublicAccessBlock(`${name}-${suffix}`, {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    return bucket;
  };
  const objectsBucket = privateBucket("objects");
  const litestreamBucket = privateBucket("litestream");

  // --- Image: built from the repository's Dockerfile and pushed to ECR. The
  // task definition uses the digest, so every new build is a new deployment.
  const repository = new aws.ecr.Repository(name, { imageTagMutability: "MUTABLE" });
  new aws.ecr.LifecyclePolicy(name, {
    repository: repository.name,
    policy: JSON.stringify({
      rules: [
        {
          rulePriority: 1,
          description: "Keep the last 10 images",
          selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 10 },
          action: { type: "expire" },
        },
      ],
    }),
  });
  const registryAuth = aws.ecr.getAuthorizationTokenOutput({ registryId: repository.registryId });
  const image = new dockerBuild.Image(name, {
    context: { location: args.buildContext },
    platforms: [dockerBuild.Platform.Linux_amd64],
    tags: [pulumi.interpolate`${repository.repositoryUrl}:latest`],
    push: true,
    buildOnPreview: false,
    registries: [
      {
        address: repository.repositoryUrl,
        username: registryAuth.userName,
        password: registryAuth.password,
      },
    ],
  });

  // --- Secrets: one Secrets Manager secret holding a JSON object; ECS injects
  // each key as an environment variable.
  const secret = new aws.secretsmanager.Secret(name, { recoveryWindowInDays: 0 });
  const secretEnvironment = pulumi.output(args.secretEnvironment);
  new aws.secretsmanager.SecretVersion(name, {
    secretId: secret.id,
    secretString: pulumi.secret(secretEnvironment.apply((values) => JSON.stringify(values))),
  });
  // Only the names go into the task definition, so it need not be a secret.
  const secretNames = pulumi.unsecret(secretEnvironment.apply((values) => Object.keys(values)));

  // --- IAM: the execution role pulls the image, writes logs and reads the
  // secret; the task role is what the server and Litestream use for S3.
  const ecsTasksTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
  });
  const executionRole = new aws.iam.Role(`${name}-execution`, { assumeRolePolicy: ecsTasksTrust });
  new aws.iam.RolePolicyAttachment(`${name}-execution`, {
    role: executionRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
  });
  new aws.iam.RolePolicy(`${name}-execution-secret`, {
    role: executionRole.id,
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secret.arn }],
    }),
  });
  const taskRole = new aws.iam.Role(`${name}-task`, { assumeRolePolicy: ecsTasksTrust });
  new aws.iam.RolePolicy(`${name}-task-s3`, {
    role: taskRole.id,
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetBucketLocation"],
          Resource: [objectsBucket.arn, litestreamBucket.arn],
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: [pulumi.interpolate`${objectsBucket.arn}/*`, pulumi.interpolate`${litestreamBucket.arn}/*`],
        },
      ],
    }),
  });

  // --- Load balancer. Targets deregister quickly: open SSE streams would
  // otherwise hold the old task (and the deploy) for the full default delay.
  const loadBalancer = new aws.lb.LoadBalancer(name, {
    loadBalancerType: "application",
    subnets: subnetIds,
    securityGroups: [albSecurityGroup.id],
    idleTimeout: ALB_IDLE_TIMEOUT_SECONDS,
  });
  const targetGroup = new aws.lb.TargetGroup(name, {
    vpcId: vpc.id,
    port: CONTAINER_PORT,
    protocol: "HTTP",
    targetType: "ip",
    deregistrationDelay: 10,
    healthCheck: { path: "/health", matcher: "200", interval: 15, healthyThreshold: 2, unhealthyThreshold: 3 },
  });
  const listeners: aws.lb.Listener[] = [];
  let url: pulumi.Output<string>;
  if (args.domain === undefined) {
    listeners.push(
      new aws.lb.Listener(`${name}-http`, {
        loadBalancerArn: loadBalancer.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
      }),
    );
    url = pulumi.interpolate`http://${loadBalancer.dnsName}`;
  } else {
    const { name: domainName, hostedZoneId } = args.domain;
    const certificate = new aws.acm.Certificate(name, { domainName, validationMethod: "DNS" });
    const validationRecord = new aws.route53.Record(`${name}-certificate-validation`, {
      zoneId: hostedZoneId,
      name: certificate.domainValidationOptions.apply((options) => options[0]?.resourceRecordName ?? ""),
      type: certificate.domainValidationOptions.apply((options) => options[0]?.resourceRecordType ?? ""),
      records: [certificate.domainValidationOptions.apply((options) => options[0]?.resourceRecordValue ?? "")],
      ttl: 300,
      allowOverwrite: true,
    });
    const validation = new aws.acm.CertificateValidation(name, {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    });
    listeners.push(
      new aws.lb.Listener(`${name}-https`, {
        loadBalancerArn: loadBalancer.arn,
        port: 443,
        protocol: "HTTPS",
        sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
        certificateArn: validation.certificateArn,
        defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
      }),
      new aws.lb.Listener(`${name}-http`, {
        loadBalancerArn: loadBalancer.arn,
        port: 80,
        protocol: "HTTP",
        defaultActions: [{ type: "redirect", redirect: { protocol: "HTTPS", port: "443", statusCode: "HTTP_301" } }],
      }),
    );
    new aws.route53.Record(`${name}-alias`, {
      zoneId: hostedZoneId,
      name: domainName,
      type: "A",
      aliases: [{ name: loadBalancer.dnsName, zoneId: loadBalancer.zoneId, evaluateTargetHealth: false }],
    });
    url = pulumi.output(`https://${domainName}`);
  }

  // --- The server.
  const logGroup = new aws.cloudwatch.LogGroup(name, { retentionInDays: args.logRetentionDays });
  const cluster = new aws.ecs.Cluster(name, {});
  const taskDefinition = new aws.ecs.TaskDefinition(name, {
    family: name,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: String(args.cpu),
    memory: String(args.memoryMiB),
    runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "X86_64" },
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi
      .all([image.ref, objectsBucket.bucket, litestreamBucket.bucket, region, logGroup.name, secret.arn, secretNames])
      .apply(([imageRef, objects, litestream, regionName, logGroupName, secretArn, secretVariables]) =>
        JSON.stringify([
          {
            name: CONTAINER_NAME,
            image: imageRef,
            essential: true,
            portMappings: [{ containerPort: CONTAINER_PORT, protocol: "tcp" }],
            stopTimeout: STOP_TIMEOUT_SECONDS,
            environment: Object.entries({
              ...args.environment,
              AWS_REGION: regionName,
              AUMOHTA_STORAGE: "s3",
              AUMOHTA_S3_BUCKET: objects,
              AUMOHTA_S3_REGION: regionName,
              AUMOHTA_LITESTREAM_REPLICA_URL: `s3://${litestream}/aumohta`,
            }).map(([variable, value]) => ({ name: variable, value })),
            secrets: secretVariables.map((variable) => ({
              name: variable,
              valueFrom: `${secretArn}:${variable}::`,
            })),
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": regionName,
                "awslogs-stream-prefix": CONTAINER_NAME,
              },
            },
          },
        ]),
      ),
  });
  const service = new aws.ecs.Service(
    name,
    {
      cluster: cluster.arn,
      taskDefinition: taskDefinition.arn,
      launchType: "FARGATE",
      // ADR-0003: never two tasks against the same database.
      desiredCount: 1,
      deploymentMinimumHealthyPercent: 0,
      deploymentMaximumPercent: 100,
      availabilityZoneRebalancing: "DISABLED",
      deploymentCircuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriodSeconds: HEALTH_CHECK_GRACE_SECONDS,
      networkConfiguration: {
        subnets: subnetIds,
        securityGroups: [taskSecurityGroup.id],
        assignPublicIp: true,
      },
      loadBalancers: [{ targetGroupArn: targetGroup.arn, containerName: CONTAINER_NAME, containerPort: CONTAINER_PORT }],
      waitForSteadyState: true,
    },
    { dependsOn: listeners },
  );

  return {
    url,
    loadBalancerDnsName: loadBalancer.dnsName,
    objectsBucket: objectsBucket.bucket,
    litestreamBucket: litestreamBucket.bucket,
    repositoryUrl: repository.repositoryUrl,
    clusterName: cluster.name,
    serviceName: service.name,
  };
}

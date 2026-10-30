# AWS deployment

`packages/infra` is a Pulumi (TypeScript) program that deploys the server
image ([docs/docker.md](docker.md)) to AWS with no manual console steps:

- a VPC with two public subnets (no NAT gateway; the task has a public IP),
- an ECR repository; `pulumi up` builds the repository's `Dockerfile` for
  `linux/amd64` and pushes it,
- an ECS Fargate service running **exactly one task** (ADR-0003): deployments
  stop the old task before starting the new one (minimum healthy 0 %, maximum
  100 %), so a deploy means a short outage,
- an Application Load Balancer, with a 120 s idle timeout so SSE Game streams
  (15 s heartbeat) stay open, and HTTPS when a domain is configured,
- S3 buckets for object storage (`POSITRONTANKS_STORAGE=s3`) and for the Litestream
  replica (`POSITRONTANKS_LITESTREAM_REPLICA_URL`); each new task restores the
  database from the replica before the server starts,
- a container stop timeout of 40 s, so Litestream's final sync on `SIGTERM`
  (up to 30 s) completes,
- a Secrets Manager secret for any secret environment variables, CloudWatch
  logs, and IAM roles scoped to the above.

The tick cost check stays off, as for any shared deployment.

## Prerequisites

- The [Pulumi CLI](https://www.pulumi.com/docs/iac/download-install/) and a
  state backend (`pulumi login`, or `pulumi login s3://...` / `--local`).
- AWS credentials in the default chain, allowed to manage VPC, ECS, ELB, ECR,
  S3, IAM, Secrets Manager, CloudWatch Logs, and (with a domain) ACM and
  Route 53.
- Docker, to build the image.

## Deploy

From the repository root:

```bash
pnpm install
pnpm build
```

Then, in `packages/infra`:

```bash
pulumi stack init prod
```

```bash
pulumi config set aws:region eu-west-1
```

```bash
pulumi up
```

`pulumi up` builds and pushes the image, creates everything and waits for the
service to become stable; the `url` output is the server's address
(`curl <url>/health`). Rerun `pnpm build` before every `pulumi up`: Pulumi runs
the compiled `dist/index.js`.

## Configuration

All keys are in the `positrontanks` namespace (`pulumi config set positrontanks:cpu 1024`).

| Key                 | Default | Meaning                                                              |
| ------------------- | ------- | -------------------------------------------------------------------- |
| `cpu`               | `512`   | Fargate CPU units                                                    |
| `memoryMiB`         | `1024`  | Fargate memory; must be valid for `cpu`                              |
| `domainName`        | unset   | Serve HTTPS on this name (with `hostedZoneId`); HTTP redirects to it |
| `hostedZoneId`      | unset   | Route 53 zone for `domainName`'s certificate validation and alias    |
| `environment`       | `{}`    | Extra plain variables, e.g. `POSITRONTANKS_MAX_*` limits                   |
| `secretEnvironment` | `{}`    | Variables stored in Secrets Manager and injected by ECS              |
| `logRetentionDays`  | `30`    | CloudWatch log retention                                             |

Object-valued keys are set with `--path`, for example
`pulumi config set --path 'environment.POSITRONTANKS_MAX_UNTHROTTLED_GAMES' 4` or
`pulumi config set --secret --path 'secretEnvironment.SOME_TOKEN' ...`.

Without `domainName` the server is plain HTTP on the load balancer's DNS name.

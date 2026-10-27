# Docker image

One image runs the server (spec section 10, ADR-0003): SQLite and local object
storage under `/data`, with optional Litestream replication of the database.
The `Dockerfile` is at the repo root; `docker/` holds its entrypoint and
Litestream configuration.

## Build and run locally

```bash
docker build -t aumohta-server .

docker volume create aumohta-data
docker run --rm -p 8080:8080 -v aumohta-data:/data -e AUMOHTA_TICK_COST_CHECK=on aumohta-server
```

Then `curl localhost:8080/health` returns `{"status":"ok"}`,
`curl localhost:8080/server` returns `{"features":{"tickCostCheck":true}}` and
`curl localhost:8080/openapi.json` returns the API document. Everything the
server writes (the SQLite database and its WAL, and the object storage
directory) is under `/data`, so the data survives `docker rm` and is reused by
the next container that mounts the same volume. A bind mount
(`-v "$PWD/data:/data"`) works too; the server runs as the image's `node` user
(uid 1000), which must be able to write to the mounted directory.

Never run two containers against the same `/data` (ADR-0003): SQLite on a
shared volume, and Litestream in particular, assume a single writer.

## Environment

The image sets these defaults; everything else uses the server's own defaults
(`packages/server/src/config.ts`, all `AUMOHTA_*` variables).

| Variable                        | Image default       | Meaning                                       |
| ------------------------------- | ------------------- | --------------------------------------------- |
| `AUMOHTA_HOST`                  | `0.0.0.0`           | Listen address                                |
| `AUMOHTA_PORT`                  | `8080`              | Listen port (also used by the `HEALTHCHECK`)   |
| `AUMOHTA_DATABASE_PATH`         | `/data/aumohta.db`  | SQLite file                                   |
| `AUMOHTA_STORAGE`               | `local`             | Object storage: `local` or `s3`               |
| `AUMOHTA_STORAGE_DIRECTORY`     | `/data/objects`     | Object directory when `AUMOHTA_STORAGE=local` |
| `AUMOHTA_LITESTREAM_REPLICA_URL`| unset               | Enables Litestream (below)                    |
| `AUMOHTA_TICK_COST_CHECK`       | unset (`off`)       | `on` enables the tick cost check (below)      |

For S3 object storage set `AUMOHTA_STORAGE=s3`, `AUMOHTA_S3_BUCKET` and
optionally `AUMOHTA_S3_KEY_PREFIX`, `AUMOHTA_S3_REGION`,
`AUMOHTA_S3_ENDPOINT`. AWS credentials, for both the server and Litestream,
come from the AWS default chain (environment variables, the ECS task role, ...).

Invalid configuration makes the server exit at startup listing every problem.

### Tick cost check

The tick cost check (`POST /tick-cost-checks`,
`POST /bot-designs/{designId}/tick-cost-checks`) runs a Program for up to ~100
Ticks synchronously on the server, so it is a local-server feature: a Player
runs their own server with `AUMOHTA_TICK_COST_CHECK=on` (as above) and their
checks load only their own machine. Shared deployments, including the Pulumi
deployment (`packages/infra`, [docs/deployment.md](deployment.md)), leave it unset, and the endpoints answer
`410 feature_disabled`. `GET /server` reports `features.tickCostCheck` so
clients can tell before calling.

With no server at all, `aumohta tick-cost --entry FILE` runs the same check
offline from an Entry file and reports the same numbers (see
[docs/spec/cli-runner.md](spec/cli-runner.md#tick-cost-check)).

## Litestream

Setting `AUMOHTA_LITESTREAM_REPLICA_URL` (for example
`s3://my-bucket/aumohta`) turns replication on. The entrypoint then:

1. restores `AUMOHTA_DATABASE_PATH` from the replica if the file does not
   exist yet and the replica has a backup (`litestream restore
   -if-db-not-exists -if-replica-exists`), so a new task with empty storage
   comes back with the latest data;
2. runs the server as a child of `litestream replicate -exec`, which streams
   every change to the replica and stops when the server stops.

The Litestream configuration (`docker/litestream.yml`, installed as
`/etc/litestream.yml`) reads both variables from the environment; set
`LITESTREAM_CONFIG` to use a different file. Unset, the server runs directly
and nothing is replicated.

On `SIGTERM` Litestream stops the server, then makes a final sync, retrying
for up to 30 seconds if the replica is unreachable; give the container a stop
timeout of at least that (`docker stop -t 40`, ECS `stopTimeout`).

To try replication locally against a second volume:

```bash
docker volume create aumohta-replica
docker run --rm -u root -v aumohta-replica:/replica aumohta-server chown node:node /replica
docker run --rm -p 8080:8080 -v aumohta-data:/data -v aumohta-replica:/replica \
  -e AUMOHTA_TICK_COST_CHECK=on -e AUMOHTA_LITESTREAM_REPLICA_URL=file:///replica/aumohta aumohta-server
```

Deleting `aumohta-data` and starting again restores the database from
`aumohta-replica`.

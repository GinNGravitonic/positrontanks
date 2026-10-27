# syntax=docker/dockerfile:1
#
# Aumohta server image (spec section 10, ADR-0003): the server with SQLite and
# local object storage under /data, plus Litestream for optional replication.
# See docs/docker.md for the environment interface and how to run it.

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.14.0
ARG LITESTREAM_VERSION=0.5.17

# --- build: install the whole workspace and compile the server and its deps ---
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b packages/server \
 && find packages -path '*/dist/*' \( -name '*.test.*' -o -name 'test-*' \) -delete

# --- prod-deps: production node_modules for the server and its workspace deps ---
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod --filter "@aumohta/server..."

# --- litestream: fetch and verify the release binary ---
FROM debian:bookworm-slim AS litestream
ARG LITESTREAM_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sha=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;; \
      arm64) arch=arm64;  sha=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    file="litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsSL -o "/tmp/${file}" "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${file}"; \
    echo "${sha}  /tmp/${file}" | sha256sum -c -; \
    tar -xzf "/tmp/${file}" -C /usr/local/bin litestream; \
    /usr/local/bin/litestream version

# --- runtime ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AUMOHTA_HOST=0.0.0.0 \
    AUMOHTA_PORT=8080 \
    AUMOHTA_DATABASE_PATH=/data/aumohta.db \
    AUMOHTA_STORAGE=local \
    AUMOHTA_STORAGE_DIRECTORY=/data/objects
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/litestream.yml /etc/litestream.yml
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/aumohta-entrypoint
# Guard against CRLF line endings from a Windows checkout.
RUN sed -i 's/\r$//' /usr/local/bin/aumohta-entrypoint /etc/litestream.yml \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps /app/packages/engine-r1/node_modules ./packages/engine-r1/node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/engine-r1/package.json ./packages/engine-r1/
COPY --from=build /app/packages/engine-r1/dist ./packages/engine-r1/dist
COPY --from=build /app/packages/language/package.json ./packages/language/
COPY --from=build /app/packages/language/dist ./packages/language/dist
COPY --from=build /app/packages/ruleset-data/package.json ./packages/ruleset-data/
COPY --from=build /app/packages/ruleset-data/dist ./packages/ruleset-data/dist
COPY --from=build /app/packages/ruleset-data/rulesets ./packages/ruleset-data/rulesets
COPY --from=build /app/packages/ruleset-data/maps ./packages/ruleset-data/maps
COPY --from=build /app/packages/ruleset-data/spec ./packages/ruleset-data/spec

USER node
WORKDIR /app/packages/server
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.AUMOHTA_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["aumohta-entrypoint"]
CMD ["node", "/app/packages/server/dist/main.js"]

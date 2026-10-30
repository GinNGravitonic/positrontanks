#!/bin/sh
# Container entrypoint for the Positron Tanks server (spec section 10, ADR-0003).
#
# Without POSITRONTANKS_LITESTREAM_REPLICA_URL it simply runs the server. With it,
# it first restores the database from the replica if the database file does
# not exist yet (a fresh volume or a new Fargate task), then runs the server
# as a child of `litestream replicate`, which streams every change to the
# replica and exits when the server does. The Litestream configuration is
# /etc/litestream.yml, which reads POSITRONTANKS_DATABASE_PATH and
# POSITRONTANKS_LITESTREAM_REPLICA_URL from the environment.
set -eu

db="${POSITRONTANKS_DATABASE_PATH:?POSITRONTANKS_DATABASE_PATH must be set}"
mkdir -p "$(dirname "$db")"

if [ "$#" -eq 0 ]; then
  set -- node /app/packages/server/dist/main.js
fi

if [ -z "${POSITRONTANKS_LITESTREAM_REPLICA_URL:-}" ]; then
  exec "$@"
fi

config="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
echo "entrypoint: restoring $db from replica if it does not exist" >&2
litestream restore -config "$config" -if-db-not-exists -if-replica-exists "$db"

# litestream -exec takes a single command string; quote each argument for sh.
command=""
for arg in "$@"; do
  command="$command '$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"
done
echo "entrypoint: replicating $db with Litestream" >&2
exec litestream replicate -config "$config" -exec "${command# }"

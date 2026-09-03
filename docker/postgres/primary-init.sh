#!/bin/sh
set -eu

# Prepares the primary to be replicated from.
#
# Mounted into /docker-entrypoint-initdb.d, so it runs ONCE, on a database that
# is being initialised for the first time. It is written to be idempotent
# anyway, because the same script has to be runnable by hand against a volume
# that already has data — an existing installation never triggers the init
# directory, and telling somebody to delete their database to enable replication
# is not a migration path.
#
#   docker compose exec postgres sh /docker-entrypoint-initdb.d/primary-init.sh
#
# See docs/adr/0020-replication-and-backups.md

REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASSWORD="${POSTGRES_REPLICATION_PASSWORD:-replicator}"

# ------------------------------------------------------------------
# A role that may stream WAL and nothing else.
#
# REPLICATION is a distinct privilege from SUPERUSER on purpose: this account
# can copy the write-ahead log and cannot read a table, write a row, or create
# anything. The standby holds its password, so the standby being compromised
# must not be the same thing as the database being compromised.
# ------------------------------------------------------------------
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REPL_USER}') THEN
    CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  ELSE
    ALTER ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  END IF;
END
\$\$;
SQL

# ------------------------------------------------------------------
# Let the replication role connect from the compose network.
#
# The image's generated pg_hba.conf permits `replication` only over a local
# socket and from 127.0.0.1 — so a standby in another container is refused, with
# an error that names pg_hba and not much else. This adds the one line that is
# missing.
#
# Scoped to the replication role rather than `all`: a wildcard here would let
# any account open a replication connection from anywhere on the network.
# ------------------------------------------------------------------
HBA="$PGDATA/pg_hba.conf"
HBA_RULE="host replication ${REPL_USER} all scram-sha-256"

if ! grep -qF "$HBA_RULE" "$HBA"; then
  printf '\n# Added by docker/postgres/primary-init.sh — streaming replication.\n%s\n' \
    "$HBA_RULE" >> "$HBA"
  echo "primary-init: added replication rule to pg_hba.conf"
else
  echo "primary-init: replication rule already present"
fi

# Only reloads if a server is actually accepting connections. During first-time
# init one is; run by hand later, one is too. Reload rather than restart —
# pg_hba is re-read on SIGHUP and nothing here needs a bounce.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "SELECT pg_reload_conf();" > /dev/null

echo "primary-init: ready to be replicated from as '${REPL_USER}'"

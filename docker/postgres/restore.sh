#!/bin/sh
set -eu

# Restores to a chosen moment in time, into a SEPARATE database.
#
# This is the half of a backup strategy that people skip, and the only half that
# proves the other one worked. A green "backup succeeded" line means a file was
# written; it says nothing about whether anything can be rebuilt from it.
#
#   RECOVERY_TARGET_TIME='2026-09-03 08:40:00+00' docker compose run --rm restore
#
# INTO A SEPARATE CONTAINER, ON ITS OWN PORT, DELIBERATELY.
# Restoring over the live database would make every rehearsal an outage, so
# nobody would rehearse. This starts a second Postgres from the backup, promotes
# it, and leaves it running on 5435 so the result can be queried and compared
# against the original. The real incident procedure is the same commands with
# the primary's data directory as the target.
#
# See docs/adr/0020-replication-and-backups.md

BUCKET="${S3_BACKUP_BUCKET:-retailstore-2n-backups}"
TARGET_TIME="${RECOVERY_TARGET_TIME:-}"

if [ -z "$TARGET_TIME" ]; then
  echo "restore: RECOVERY_TARGET_TIME is required, e.g. '2026-09-03 08:40:00+00'" >&2
  echo "restore: without it this would replay the whole archive, which is a" >&2
  echo "restore: restore of the present rather than of a moment." >&2
  exit 2
fi

# ------------------------------------------------------------------
# Pick the newest base backup taken at or before the target.
#
# A backup taken AFTER the target is useless: recovery only rolls forward, so it
# already contains the thing being recovered from. `mc ls` returns the names in
# lexical order, and the labels are sortable UTC timestamps for exactly this.
# ------------------------------------------------------------------
echo "restore: looking for a base backup at or before ${TARGET_TIME}"

# base-YYYYmmddTHHMMSSZ -> YYYYmmddHHMMSS, so it compares against the target
# reduced to the same shape.
TARGET_KEY=$(echo "$TARGET_TIME" | sed 's/[-: +]//g' | cut -c1-14)

CHOSEN=""
for label in $(mc -q ls "backups/${BUCKET}/base/" | awk '{print $NF}' | tr -d '/' | sort); do
  key=$(echo "$label" | sed 's/^base-//; s/[TZ]//g')
  if [ "$key" -le "$TARGET_KEY" ]; then
    CHOSEN="$label"
  fi
done

if [ -z "$CHOSEN" ]; then
  echo "restore: no base backup exists at or before ${TARGET_TIME}." >&2
  echo "restore: the earliest recoverable moment is the oldest base backup," >&2
  echo "restore: not the oldest WAL segment. Take one with:" >&2
  echo "restore:   docker compose --profile tools run --rm base-backup" >&2
  exit 1
fi

echo "restore: using ${CHOSEN}"

# ------------------------------------------------------------------
# Unpack it.
# ------------------------------------------------------------------
rm -rf "$PGDATA"
mkdir -p "$PGDATA"

mc -q cp "backups/${BUCKET}/base/${CHOSEN}/base.tar.gz" /tmp/base.tar.gz
tar -xzf /tmp/base.tar.gz -C "$PGDATA"
rm -f /tmp/base.tar.gz

# Postgres refuses to start on a data directory it does not own with 0700.
chmod 0700 "$PGDATA"

# ------------------------------------------------------------------
# Tell it to recover, and how far.
#
# `recovery.signal` is what makes this a recovery rather than a normal start
# (PG12 removed recovery.conf). Its presence plus the settings below is the
# whole mechanism.
# ------------------------------------------------------------------
cat >> "$PGDATA/postgresql.auto.conf" <<CONF

# --- written by docker/postgres/restore.sh ---
# Where to fetch WAL from. The mirror image of archive_command on the primary:
# %f is the segment wanted, %p where to put it.
restore_command = 'mc -q cp backups/${BUCKET}/wal/%f %p'

# The moment to stop at. Recovery replays forward and halts here, so the
# database comes up as it was at this instant — one second before a mistake, if
# that is what this is for.
recovery_target_time = '${TARGET_TIME}'

# Stop AT the target, not just before it.
recovery_target_inclusive = on

# Come up read-write once the target is reached, rather than sitting in
# recovery waiting for WAL that will never arrive.
recovery_target_action = 'promote'
CONF

touch "$PGDATA/recovery.signal"

# A standby's signal file would make this follow a primary forever instead of
# promoting. pg_basebackup did not write one here, but a base backup taken from
# a standby would have.
rm -f "$PGDATA/standby.signal"

echo "restore: recovering to ${TARGET_TIME}…"
echo ""

# Hands over to the image's entrypoint, which starts Postgres as the right user.
# It finds recovery.signal, replays the archive to the target, promotes, and
# then serves normally — so the container ends up as an ordinary database that
# happens to hold the past.
exec docker-entrypoint.sh postgres

#!/bin/sh
set -eu

# Takes a base backup and puts it in object storage.
#
# WHY THIS EXISTS SEPARATELY FROM WAL ARCHIVING
# The archive is a stream of changes, and a stream of changes restores nothing
# on its own — recovery replays WAL *onto* a copy of the database. So
# point-in-time recovery needs both, and the oldest recoverable moment is the
# oldest base backup you still have, not the oldest WAL segment.
#
# Run on demand, or on a schedule:
#   docker compose run --rm base-backup
#
# WHAT THIS IS NOT
# A retention policy, an incremental backup, or a verification pass. pgBackRest
# and barman do all three; this does the one thing that makes recovery possible
# and says so. In Kubernetes it is replaced by CloudNativePG's
# `barmanObjectStore`, which schedules, retains and verifies properly.
#
# See docs/adr/0020-replication-and-backups.md

PRIMARY_HOST="${PRIMARY_HOST:-postgres}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
BUCKET="${S3_BACKUP_BUCKET:-retailstore-2n-backups}"

# UTC, and sortable. The restore picks the newest base backup at or before the
# recovery target, so the name has to sort chronologically as a string.
LABEL="base-$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="/tmp/${LABEL}"

echo "base-backup: starting ${LABEL} from ${PRIMARY_HOST}:${PRIMARY_PORT}"

until PGPASSWORD="$PGPASSWORD" pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" -q; do
  echo "base-backup: waiting for the primary…"
  sleep 2
done

mkdir -p "$STAGING"

# --wal-method=none, deliberately.
#
# `stream` would embed the WAL needed to make this backup self-consistent, which
# is right for a standalone copy. Here the archive already has every segment, and
# recovery reads from the archive — so embedding it would store the same bytes
# twice and, worse, invite the belief that the base backup alone is enough.
#
# The trade is that this backup is NOT restorable without the archive. That is
# the correct coupling for PITR and the wrong one for a single-file export.
PGPASSWORD="$PGPASSWORD" pg_basebackup \
  --host="$PRIMARY_HOST" \
  --port="$PRIMARY_PORT" \
  --username="$REPL_USER" \
  --pgdata="$STAGING" \
  --format=tar \
  --gzip \
  --wal-method=none \
  --checkpoint=fast \
  --progress \
  --verbose

# The LSN this backup starts from, which is where recovery begins replaying.
# Kept beside the backup so a restore does not have to open the tarball to
# find out whether the archive still reaches back far enough.
cat > "${STAGING}/BACKUP_INFO" <<INFO
label=${LABEL}
taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INFO

echo "base-backup: uploading to ${BUCKET}/base/${LABEL}/"
mc -q cp --recursive "${STAGING}/" "backups/${BUCKET}/base/${LABEL}/"

rm -rf "$STAGING"

echo "base-backup: ${LABEL} complete"
echo ""
echo "  Recovery from this point onward is possible as long as BOTH survive:"
echo "    ${BUCKET}/base/${LABEL}/   the copy"
echo "    ${BUCKET}/wal/             every segment since"

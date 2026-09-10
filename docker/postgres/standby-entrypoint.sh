#!/bin/sh
set -eu

# Brings up a streaming standby.
#
# A standby is not a Postgres that was told to follow something. It is a
# byte-for-byte copy of the primary's data directory, replaying the primary's
# write-ahead log forever. So the first start is a clone, and every start after
# that is an ordinary boot that happens to find `standby.signal` on disk.
#
# Replaces the image's entrypoint, does the clone when there is nothing to boot,
# and then hands over to the real entrypoint rather than reimplementing it.
#
# See docs/adr/0020-replication-and-backups.md

PRIMARY_HOST="${PRIMARY_HOST:-postgres}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
SLOT="${REPLICATION_SLOT:-standby1}"

# ------------------------------------------------------------------
# First start only.
#
# PG_VERSION is written by initdb and by pg_basebackup, so its presence is the
# question "is there a data directory here?" answered without guessing. A
# restart must NOT re-clone: that would throw away everything the standby has
# replayed and, worse, mask a broken replication link behind a fresh copy that
# looks healthy.
# ------------------------------------------------------------------
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "standby: no data directory — cloning from ${PRIMARY_HOST}:${PRIMARY_PORT}"

  # The primary's healthcheck gates this service, but healthy means "accepting
  # connections", and the replication role is created by an init script that
  # runs in that same window. So wait for the thing actually needed rather than
  # the thing compose can observe.
  until PGPASSWORD="$PGPASSWORD" pg_isready \
      -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" -q; do
    echo "standby: waiting for the primary to accept replication logins…"
    sleep 2
  done

  # ----------------------------------------------------------------
  # Does the slot already exist?
  #
  # THE SLOT LIVES ON THE PRIMARY, NOT HERE. So deleting this container's
  # volume to rebuild the standby does not remove it, and `pg_basebackup
  # --create-slot` then fails with "replication slot already exists". With
  # `restart: unless-stopped` in front of it, that is not a failure — it is an
  # infinite crashloop that also pins WAL on the primary forever.
  #
  # Found by deleting the volume and rebuilding, which is exactly the operation
  # somebody performs when a standby has gone wrong.
  # ----------------------------------------------------------------
  slot_state=$(
    PGPASSWORD="$PGPASSWORD" psql \
      --host="$PRIMARY_HOST" --port="$PRIMARY_PORT" \
      --username="$REPL_USER" --dbname=postgres \
      --tuples-only --no-align --quiet \
      --command="SELECT coalesce(
                   (SELECT CASE WHEN active THEN 'active' ELSE 'inactive' END
                      FROM pg_replication_slots WHERE slot_name = '${SLOT}'),
                   'absent')" 2>/dev/null || echo "unknown"
  )

  case "$slot_state" in
    absent)
      echo "standby: slot '${SLOT}' does not exist — creating it"
      CREATE_SLOT="--create-slot"
      ;;
    inactive)
      # The normal rebuild case: a previous standby left its slot behind. Reuse
      # it. This is also why the WAL it has been retaining is still there.
      echo "standby: reusing existing inactive slot '${SLOT}'"
      CREATE_SLOT=""
      ;;
    active)
      # Something else is streaming through this slot. Two standbys sharing one
      # slot is not a race worth entering, and retrying cannot fix it.
      echo "standby: FATAL — slot '${SLOT}' is already ACTIVE." >&2
      echo "standby: another standby is using it. Give this one its own" >&2
      echo "standby: REPLICATION_SLOT, or drop the slot on the primary:" >&2
      echo "standby:   SELECT pg_drop_replication_slot('${SLOT}');" >&2
      exit 1
      ;;
    *)
      echo "standby: could not determine the state of slot '${SLOT}'" >&2
      exit 1
      ;;
  esac

  # -R  writes standby.signal and primary_conninfo, so this directory boots as
  #     a standby with no further configuration.
  # -S  binds to the physical replication SLOT. Without a slot the primary is
  #     free to recycle WAL the standby has not consumed yet, and a standby that
  #     falls behind during a restart never catches up — it fails with
  #     "requested WAL segment has already been removed" and has to be rebuilt.
  #     The slot makes the primary retain that WAL instead.
  # -Xs streams WAL during the copy, so a long clone cannot outrun its own
  #     starting point.
  # shellcheck disable=SC2086  # CREATE_SLOT is deliberately word-split or empty
  PGPASSWORD="$PGPASSWORD" pg_basebackup \
    --host="$PRIMARY_HOST" \
    --port="$PRIMARY_PORT" \
    --username="$REPL_USER" \
    --pgdata="$PGDATA" \
    --format=plain \
    --wal-method=stream \
    --write-recovery-conf \
    --slot="$SLOT" $CREATE_SLOT \
    --checkpoint=fast \
    --progress \
    --verbose

  # pg_basebackup writes as whoever ran it; the server refuses to start on a
  # data directory it does not own, with permissions 0700 required.
  chmod 0700 "$PGDATA"

  echo "standby: clone complete, booting as a standby"
else
  echo "standby: data directory present — booting and resuming replay"
fi

# The image's own entrypoint from here: it handles the postgres user, signal
# forwarding and shutdown properly, and none of that is worth reimplementing.
exec docker-entrypoint.sh postgres

# 20. A streaming standby, and why it is not a backup

- **Status:** Accepted — replication and point-in-time recovery both done
- **Recorded:** 2026-09-02

## Context

Compose runs one Postgres. It holds every order, every refund, every credential
and every audit row, on one volume, on one machine, with no copy of any kind.

Two different problems get conflated here, and conflating them is how people end
up with neither solved:

**A machine dies.** The disk fails, the node is evicted, the process is OOM
killed with a corrupted page. What is wanted is another copy of the data that is
seconds behind, not hours.

**Somebody destroys data correctly.** A `DELETE` with the wrong `WHERE`, a
`DROP TABLE`, a migration that runs against production. The database did exactly
what it was told. What is wanted is the ability to go back to a moment before
it happened.

A replica solves the first and is actively useless for the second: it copies the
destruction faithfully, in milliseconds, and that is it working correctly. So the
two need separate mechanisms, and the second is the one people skip because the
first *feels* like it covers it.

## Decision

Build both, in that order, and be explicit in the code about which does what.

### Streaming replication — done

A second Postgres service, `postgres-replica`, behind a compose profile so it is
opt-in:

```
docker compose --profile ha up -d postgres-replica
```

**A standby is a byte-for-byte clone that replays WAL forever**, not a Postgres
that was told to follow something. So the first start is a clone
(`pg_basebackup`) and every start after is an ordinary boot that finds
`standby.signal` on disk. `docker/postgres/standby-entrypoint.sh` does the clone
only when there is no data directory, then hands over to the image's own
entrypoint rather than reimplementing signal handling and shutdown.

**A replication slot, not `wal_keep_size`.** Without a slot the primary is free
to recycle WAL the standby has not consumed, so a standby that falls behind
during a restart never catches up — it fails with *"requested WAL segment has
already been removed"* and has to be rebuilt from scratch. The slot makes the
primary retain that WAL instead.

The cost is real and worth stating: **an inactive slot retains WAL forever.**
A standby deleted without dropping its slot will fill the primary's disk. That
is the failure mode to watch, and it is the price of the one above.

It also produced the sharpest bug in this work, which only appears when
somebody tries to *recover* from a broken standby. **The slot lives on the
primary**, so deleting the standby's volume to rebuild it does not remove the
slot — and `pg_basebackup --create-slot` then fails with "replication slot
already exists". Behind `restart: unless-stopped` that is not a failure, it is
an infinite crashloop, re-cloning 36MB and deleting it every few seconds while
still pinning WAL on the primary.

The entrypoint therefore inspects the slot before cloning and handles all three
states: absent (create it), inactive (reuse it — a rebuild, and the retained
WAL is why it can catch up), active (refuse, loudly, because two standbys
sharing one slot is not a race worth entering and retrying cannot fix it).

Worth noting how it was found: not by reading the code, but by deleting the
volume and rebuilding — which is exactly the operation somebody performs at the
worst possible moment.

**A role that may stream WAL and nothing else.** `REPLICATION` is a separate
privilege from `SUPERUSER`; `replicator` cannot read a table, write a row, or
create anything. The standby holds its password, so the standby being
compromised must not be the same event as the database being compromised.

**Asynchronous.** With `synchronous_commit = remote_apply` the primary waits for
the standby before acknowledging each commit — checkout latency would then
depend on the replica, and a replica outage would stop the site taking money.
Asynchronous means a primary crash can lose the last few milliseconds of
commits. That is the trade, and the tail of a transaction log is exactly what
point-in-time recovery exists to recover.

### Nothing reads from the replica

The application sends every query to the primary, deliberately.

Routing reads to a standby introduces **read-your-writes** bugs, and the ones
that matter are the ones that look like data loss to a user: a buyer completes
checkout and lands on an order list that has not replayed their order yet. Fixing
that properly means routing per query by whether the session has written
recently, which is real work and a real source of subtle bugs.

It would also be solving a problem that is already solved. The caching in
[ADR 0019](0019-cache-tiering-rule.md) absorbed the read volume a replica would
have relieved — a warm listing page touches the database zero times. Adding a
replica to serve queries a cache already answers is the expensive way round.

**The replica is here to be promoted, not queried.**

### Point-in-time recovery — done

`archive_mode = on`, with every completed WAL segment copied to object storage:

```
archive_command = mc -q cp %p backups/retailstore-2n-backups/wal/%f
archive_timeout = 60
```

**The exit code is load-bearing.** Postgres keeps a segment until the command
succeeds and retries forever if it fails, so a broken archive fills the data
directory rather than losing backups silently. That is the right failure, and it
is why this must never end in `|| true`.

`archive_timeout = 60` forces a segment switch once a minute even when idle.
Without it a quiet database archives nothing until 16MB has accumulated, so the
recovery point could be hours old.

**A separate, private bucket.** `retailstore-2n-backups`, with no anonymous policy at
all — as against `retailstore-2n-uploads`, which grants the world `GetObject`. A base
backup is a byte-for-byte copy of the entire database: every password hash,
every order, every address. One policy mistake away from being the same bucket
is too close.

**A base backup is required too, and this is the part that surprises people.**
WAL alone restores nothing — recovery replays the log *onto* a copy. So the
oldest recoverable moment is the oldest base backup still held, not the oldest
WAL segment. `docker/postgres/base-backup.sh` takes one with
`--wal-method=none`, deliberately: embedding WAL would store the same bytes
twice and invite the belief that the base backup alone is enough.

**Why `mc` and not pgBackRest, WAL-G or barman.** All three are better tools and
all three want a package manager, a config file and a service of their own. `mc`
is a single static binary copied from the image that already bootstraps the
bucket — two lines and no new failure mode. It is also honest about its ceiling:
this gives archiving and PITR, and none of the incremental backup, parallel
restore, retention policy or verification the real tools do. Kubernetes replaces
it with CloudNativePG's `barmanObjectStore`.

### The restore is the deliverable, not the backup

A backup that has never been restored is not a backup, it is a hope. Retention
settings and a green "backup succeeded" line prove a file was written; they say
nothing about whether anything can be rebuilt from it.

`scripts/restore-drill.ts` creates a table, fills it, notes the time, forces the
segment into object storage, **drops the table**, then recovers to the instant
before and counts both databases:

```
                                            LIVE      RESTORED
  restore_drill.canary rows                 gone           500
  listings                                   927           927
```

**Into a second container on port 5435, never over the live one.** A rehearsal
that causes an outage is a rehearsal nobody performs, and one nobody performs is
worthless in an incident. The real procedure is the same script pointed at the
primary's data directory.

Two details that make it trustworthy rather than theatrical:

- **The recovery target comes from Postgres's clock**, not the script's.
  `recovery_target_time` is compared against commit timestamps in the WAL, so a
  machine whose clock is a few seconds off would silently recover to the wrong
  instant.
- **It waits for promotion, not for connections.** A recovering database accepts
  connections and answers queries as a read-only standby well before it has
  finished replaying. Checking `pg_is_in_recovery()` is the difference between
  reading the past and reading a half-replayed version of it.

It also asserts the *whole* database came back, not just the drill table — 927
listings on both sides. A restore that produced only the one table would mean
something far stranger had happened.

**Rehearsed three times consecutively, clean each time.** That is the actual
bar: not that a restore worked once, but that it is boring.

## Consequences

**Replication is verified rather than assumed.** `scripts/replication-demo.ts`
asserts the four things that have to be true, because a second Postgres that
starts without error is indistinguishable from an empty database nobody is
streaming to — both are healthy and both answer queries.

| Checked | Result |
| --- | --- |
| Primary not in recovery, replica is | ok |
| Primary sees exactly one standby, `streaming` | ok |
| A replication slot is active | ok |
| The replica refuses writes (server-enforced) | ok |
| Five committed rows arrive | median **11.1ms**, slowest 14.2ms |
| 500 rows dropped, then recovered | all **500** back, whole database intact |

And three lifecycle paths, each verified by hand rather than reasoned about:
a first clone onto an empty volume, a rebuild onto an empty volume where the
slot survives, and a plain restart — which must *not* re-clone, since that
would discard everything replayed and hide a broken link behind a fresh copy
that looks healthy.

**The primary now has a second thing that can fill its disk.** An orphaned
replication slot retains WAL indefinitely. Monitoring
`pg_replication_slots.active` matters in a way it did not before.

**An existing installation needs one manual step.** `/docker-entrypoint-initdb.d`
runs only on a database being initialised, so an existing volume never sees the
replication setup. `docker/postgres/primary-init.sh` is therefore idempotent and
runnable by hand — telling somebody to delete their database to enable
replication is not a migration path.

**Two more services in Kubernetes, or none.** CloudNativePG expresses all of the
above as `instances: 3` plus a `barmanObjectStore` block, including failover,
which Compose cannot do at all: nothing here promotes the standby automatically.
That is the point of doing it in Compose first — the mechanism is understood
before an operator hides it.

## Alternatives considered

**Logical replication instead of physical.** Per-table, version-independent,
and can replicate into a differently-shaped schema. Rejected: it does not
replicate DDL, so every migration would need applying by hand on the subscriber,
and it cannot be promoted to a primary the way a physical standby can. The goal
here is a spare primary, not a data feed.

**`pg_dump` on a schedule.** Simple, portable, and a genuinely useful second
line. Rejected as the *primary* mechanism because the recovery point is the last
dump — losing up to a day of orders — and a dump of a growing database takes
increasingly long while holding a snapshot open. WAL archiving gives a recovery
point measured in seconds.

**A managed Postgres with replication and backups included.** Correct answer for
a real product, and what this would use given a budget. Rejected here because
the entire point is to demonstrate the mechanism rather than a provider's
checkbox — and because a managed service would make this ADR one sentence long.

**Synchronous replication.** Would remove the "last few milliseconds" caveat
entirely. Rejected: it makes the primary's write availability depend on the
standby's, so a single replica outage stops checkout. Worth revisiting with
three or more standbys and `synchronous_standby_names = 'ANY 1 (...)'`, where
any one being available is enough.

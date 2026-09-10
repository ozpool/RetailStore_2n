# 32. Kubernetes: an operator for Postgres, plain manifests for everything else

- **Status:** Accepted — implemented 2026-09-09 in [`k8s/`](../../k8s/), with
  `src/jobs.ts` as the entrypoint the CronJob calls. Verified on kind:
  failover promoted a replica with committed data intact and zero API
  restarts. **Nothing has run on a real cluster.** See
  [plan 0004](../plans/0004-kubernetes.md).
- **Recorded:** 2026-09-09

## Context

Compose is the deployment story, and it cannot do two things that matter:

- **Nothing promotes the standby.** Physical replication works and the restore
  is rehearsed ([ADR 0020](0020-replication-and-backups.md)), but a dead primary
  stays dead until somebody intervenes.
- **Nothing is scheduled.** Base backups are taken on demand and nothing expires
  the old ones. A payout claimed and never sent — the provider timed out — stays
  `PENDING` until `sendPendingPayouts()` is called, and nothing calls it.

Both are an orchestrator's job, and [ADR 0023](0023-one-dockerfile-many-targets.md)
already shaped the images for one: five build targets, one process each,
`migrate` deliberately a one-shot rather than an API startup step because
"several replicas racing `migrate deploy` is a problem worth not having".

**What is NOT a reason to do this, despite appearances.** The repository says in
several places that "a `setInterval` in a web process is a worse cron than
cron", which reads like an admission that nothing runs on a schedule. It is not.
Five recovery sweepers start with the API — reservations, in-flight orders,
quiet-hours deliveries, stale deliveries, outbox retention — and they are
deliberate. Each claims its work with a conditional `UPDATE`, so N replicas
divide it rather than doing it N times. That line was always about two specific
things: backup retention, and moving money on a timer.

Getting this wrong in the obvious direction — "Kubernetes has CronJobs, so move
the timers into CronJobs" — would be a regression, and most of this record
exists to say why.

## Decision

### The recovery sweepers stay in the API process

Five `setInterval` loops, unchanged, on every replica.

**Rejected: a CronJob per sweeper.** It looks tidier and is worse in three ways.

*It serialises work that currently parallelises.* Three API replicas today mean
three sweepers dividing one queue by conditional `UPDATE`. One CronJob is one
worker, so throughput falls as the deployment grows — the opposite of what
scaling out is for.

*It puts recovery on a schedule instead of continuously.* A reservation sweeper
that runs every five minutes means a listing can sit hidden from the catalogue
for five minutes after its hold expired. The current loop is tighter than any
cron granularity worth configuring.

*It multiplies the failure surface.* Five more workloads, five more images to
schedule, five more things whose absence is silent. A sweeper that stops
because the API stopped is a sweeper whose failure is already visible.

The `setInterval`-is-a-bad-cron argument does not apply to these because they
are not scheduled work. They are **recovery** work — reaching state no request
path can reach — and the natural place for it is the process that owns the
database connection pool it needs.

### Exactly one CronJob of our own: unsent payouts

```
sendPendingPayouts()  — every 15 minutes
```

This is the one genuine orphan. The payout claim commits before the transfer
([ADR 0029](0029-payouts-separate-transfers-not-destination-charges.md)), so a
process that dies in between leaves money reserved and unsent, and unlike the
delivery ledger's ambiguous middle nothing comes back for it.

**Why a CronJob and not a sixth in-process sweeper**, given the argument above:
because this one *moves money to a third party*. The sweepers recover local
state; this calls Stripe. A retry loop inside the process serving checkout
means a provider outage and a traffic spike share a thread pool, and it means
"why did this seller get paid at 03:14" has no answer outside application logs.
A Job has an exit code, a start time, and a record.

Safe to run beside a seller pressing the button — but not for the reason it
first appears, and the distinction was worth finding. `sendClaimedPayout` opens
with a status check, and that check is a **read**: two workers can both pass it
and both call the provider. What makes it safe is the idempotency key, which
returns *the same transfer* to both, and the `status` in the settling
`UPDATE`'s `WHERE`, which lets only one of them record it.

The pre-check is an optimisation, not the guard. Believing otherwise is how
somebody later "simplifies" the idempotency key away.

### Backup retention is not a CronJob we write

CloudNativePG's `barmanObjectStore` has `retentionPolicy`. ADR 0020 predicted
this — "CloudNativePG expresses all of the above as `instances: 3` plus a
`barmanObjectStore` block, including failover" — and the prediction is the
decision now.

**Rejected: a StatefulSet plus our own `docker/postgres` image.** It would work,
and it would mean reimplementing failover, backup scheduling, retention and
verification by hand — the four things the operator exists for. `primary-init.sh`
and `archive_command` were worth writing in Compose because the mechanism is
worth understanding before an operator hides it. Understanding it is not a
reason to keep maintaining it.

### Kustomize, not Helm

Plain YAML with overlays. **Rejected: a chart.** `values.yaml` becomes a second
configuration language beside `.env`, and templated YAML is neither valid YAML
nor a real language — for an application whose operators are also its authors,
the indirection buys nothing.

### Kafka is an overlay, and so are the relay and worker

The base deploys `NOTIFY_TRANSPORT=inline` with **no** relay and **no** worker.

This follows from what inline means: the relay hands events straight to the
consumer functions inside the API, so a relay Deployment would be a container
for a function call. Deploying relay and worker without a broker would give two
workloads with nothing to do — which is the mistake the compose `messaging`
profile already avoids, and the overlay is that profile.

`overlays/messaging` adds the broker, the relay, the worker, and flips the
transport. Strimzi is not used: one broker does not need an operator, and
[ADR 0025](0025-kafka-topics-and-partitioning.md) already concedes Kafka is
oversized at this volume.

### The API gets no Ingress

One Ingress, to `web`. The API is a `ClusterIP` Service that only `web` resolves.

This is not hardening bolted on; it is what [ADR 0002](0002-bff-proxy.md) has
been arranging since the beginning. The browser talks only to Next.js, which
proxies with the cookies relayed — so in Kubernetes the API simply has no
public address to attack, and `BACKEND_URL: http://api:4000` carries over from
Compose unchanged.

### Secrets have no defaults, and a missing one stops the rollout

`docker-compose.yml` defaults everything — `JWT_SECRET:-compose-only-not-a-real-secret-000000`,
MinIO keys, a replication password. That is right for a `git clone` that has to
work in one command, and wrong for anything else.

The manifests read every credential from a `Secret` with **no fallback**. A
missing key fails the pod, loudly, at start. The cost is real: `kubectl apply`
alone will not bring the stack up, and that is the intended difference between
a demo and a deployment.

## Consequences

**Failover stops being manual**, which is the single largest operational gap in
the project.

**One scheduled job exists, and it is the one that needed to.** Not five, not
six.

**Two deployment descriptions now have to agree.** Compose and the manifests
will drift — the same problem ADR 0023 solved for images by refusing to have two
Dockerfiles, and it does not have an equivalent answer here. Compose stays the
development story and the manifests the deployment one; where they disagree
about anything but topology, the manifests are wrong.

**`dist/jobs.js` was built for this**, since the sweepers were library exports
with no entrypoint. It needed no Dockerfile change: `api-build` compiles
everything in `src`, so it shipped in the existing image.

**Liveness for the relay and the worker is unsolved.** Neither serves HTTP, so
they inherit no probe — ADR 0023 already noted that a real signal is consumer
lag at `/health/lag`. Until that is wired, a wedged worker in the messaging
overlay is a process Kubernetes believes is fine. Recorded, not solved.

**Nothing here reads from the replica.** CNPG will happily provide a read-only
service and the application must not use it, for the read-your-writes reason
ADR 0020 gives. An operator making replicas easy does not make routing reads to
them correct.

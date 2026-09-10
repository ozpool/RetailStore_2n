# Plan 0004 — Running it on Kubernetes

- **Status:** all six phases landed 2026-09-09, verified on kind. Nothing has
  run on a real cluster.
- **Written:** 2026-09-09
- **Produces:** ADR 0032

> **What this is now.** The manifests are in [`k8s/`](../../k8s/) with their own
> README; this file is the decision trail, including two failures that only
> showed up by running it.

---

## 1. Where this stands today

Compose runs the whole system in one command and cannot do two things:
promote the standby when the primary dies, and run anything on a schedule.

The images are already shaped for an orchestrator —
[ADR 0023](../adr/0023-one-dockerfile-many-targets.md) made five single-process
targets and kept migrations out of API startup specifically so they could be a
Job. What is missing is the manifests, and one entrypoint.

## 2. What is being built

```
k8s/
  base/            postgres (CNPG), redis, minio, api, web, migrate Job,
                   the payout CronJob, one Ingress to web
  overlays/
    local/         kind: NodePort instead of Ingress, 1 replica, MinIO
    messaging/     kafka + relay + worker, NOTIFY_TRANSPORT=kafka
```

Deliberately **not** built: a CronJob per sweeper. The five recovery sweepers
stay in the API process, for the three reasons ADR 0032 gives — chiefly that N
replicas currently divide the work by conditional `UPDATE`, and one CronJob
would serialise it.

## 3. Phases

### ~~Phase 0 — Decide, and write it down~~ · landed 2026-09-09

- ADR 0032: an operator for Postgres, plain kustomize for everything else; the
  sweepers stay in-process; one CronJob; no Ingress for the API; Secrets with no
  defaults.

**Exit:** one record naming its rejected alternatives.

**Met.** The alternative worth arguing about was "Kubernetes has CronJobs, so
move the timers into CronJobs", and most of the record exists to explain why
that is a regression rather than a tidy-up.

### ~~Phase 1 — The entrypoint a CronJob can call~~ · landed 2026-09-09

- `src/jobs.ts` compiled to `dist/jobs.js`, taking a job name: `payouts:pending`
  to start, and the other exports registered beside it so the list is one place.
- Exits non-zero on failure, so a Job's status means something.
- Logs one line of counts, so `kubectl logs` answers "did it do anything".

**Exit:** `node dist/jobs.js payouts:pending` settles a stranded payout and
exits 0; an unknown job name exits 2 rather than silently succeeding.

**Met.** Both, and the image needed no change — `api-build` already compiles
everything in `src`, so `dist/jobs.js` shipped for free.

The other five sweepers are registered in the same file and **not** scheduled.
They are there because an operator after an incident otherwise reaches for
`npx tsx -e` against library internals, which is how a production database gets
a typo, and because one list cannot silently disagree with `src/index.ts` the
way two would.

### ~~Phase 2 — The base manifests~~ · landed 2026-09-09

- Deployments for `api` and `web`; ClusterIP Services for both; one Ingress to
  `web` only.
- `migrate` as a Job, with the image's `api-build` target.
- Secrets and ConfigMaps split on the line ADR 0032 draws: no credential has a
  default, and a missing one fails the pod.
- Probes: `/health` for both tiers, with the API's `startupProbe` generous
  enough for a cold Prisma client.

**Exit:** `kubectl apply -k k8s/overlays/local` on kind brings the stack up, the
migrate Job completes, and the storefront serves a seeded listing.

**Met on the second attempt.** The first cold start failed twice, and both
failures are the reason this phase was worth doing rather than reasoning about:

- **A generated Secret's name never reached the CNPG `Cluster`.**
  `secretGenerator` hashes the name so a credential change rolls the pods, and
  kustomize rewrites every *known* reference — but `Cluster` is a CRD, so
  `spec.bootstrap.initdb.secret.name` is not one of them. The bootstrap pod
  failed with `CreateContainerConfigError`, which says nothing about names.
  Fixed by teaching the transformer that one field, not by
  `disableNameSuffixHash`, which fixes it by giving up the feature.
- **The `migrate` Job fired before Postgres existed.** Compose had
  `depends_on: condition: service_healthy`; Kubernetes has no equivalent for a
  Job. It hit `P1001` three times and went `Failed`. An initContainer now
  TCP-polls `postgres-rw:5432` — a connect is the right check because CNPG's
  `-rw` Service has no endpoints until an instance is primary and ready.

`kubectl apply -k` exiting 0 is not the same as the stack coming up, and that is
the whole lesson of the phase.

### ~~Phase 3 — Postgres via CloudNativePG~~ · landed 2026-09-09

- A `Cluster` with `instances: 3` and a `barmanObjectStore` pointing at the same
  bucket Compose archives to, with `retentionPolicy` — the thing
  [ADR 0020](../adr/0020-replication-and-backups.md) said would replace
  `archive_command` and the hand-rolled standby.
- The application connects to the `-rw` service only. Nothing uses `-ro`.

**Exit:** deleting the primary pod produces a promoted replica and an API that
reconnects, demonstrated rather than asserted.

**Met, and the strong form of it.** `k8s/failover-demo.sh` writes a row, deletes
the primary, and afterwards finds **2 of 2** rows in the promoted instance — the
one committed before the failure and one written after it. `api restarts 0 -> 0`:
Prisma's pool followed the `-rw` Service on its own rather than needing a
bounce, which is the part that would otherwise have been hidden by an
orchestrator helpfully restarting the pod.

**Slow, and reported rather than smoothed over.** 199 seconds on one node with
no free memory. The first attempt looked like a hang at two minutes and was
simply not finished. The demo prints the elapsed time and how many polls saw a
bad status, because a promotion is a short automatic outage and pretending
otherwise would be the lie this repository avoids.

### ~~Phase 4 — The one CronJob~~ · landed 2026-09-09

- `payouts:pending` every 15 minutes, `concurrencyPolicy: Forbid`,
  `successfulJobsHistoryLimit` low enough to read.

**Exit:** a payout stranded by a killed process is settled by the CronJob within
one interval, and running two at once produces one transfer.

**Met, and it found a real flaw in the reporting.** Two concurrent Jobs settled
one payout — one transfer, as claimed — but the loser reported `failed=1`, and a
scheduled money-mover whose `failed` count includes ordinary races trains its
operator to ignore the number that matters.

Chasing that turned up something worth knowing: `sendClaimedPayout`'s opening
status check is a **read**, so two workers both pass it and both call
`transfer()`. That is safe, but not for the reason the comments implied — safety
is the idempotency key handing both the same transfer, plus `status` in the
settling `UPDATE`'s `WHERE` letting one record it. The pre-check is an
optimisation, not the guard, and ADR 0032 now says so, because believing
otherwise is how somebody later removes the idempotency key.

`updateMany`'s count was the signal already sitting there unused. `sent` now
means "this run sent it" and `raced` means "another run did, and this one got
the same transfer back": `sent=1 raced=1 failed=0` where it used to say
`sent=2` for one payout.

### ~~Phase 5 — Prove it, and correct the record~~ · landed 2026-09-09

- A demo script in the style of the others: kill the primary, watch failover,
  strand a payout, watch the CronJob settle it.
- Rewrite the five places that say "a `setInterval` in a web process is a worse
  cron than cron" so they read as the justification for this design rather than
  an apology for its absence. One of them —
  [`sellerPayouts.ts`](../../backend/src/routes/sellerPayouts.ts) — is about
  payouts being seller-triggered by choice and should not change at all.

**Exit:** the README describes what runs on a schedule and what does not, and is
accurate about both.

**Met, and it started by correcting an error that predated the plan.** The
README claimed outbox retention and the stale-delivery sweep "have to be invoked
by something else" when both are started by the API twenty lines apart in
`src/index.ts`. Five recovery sweepers have been running on a timer all along.

Four of the five "worse cron than cron" passages were rewritten. The fifth, in
[`sellerPayouts.ts`](../../backend/src/routes/sellerPayouts.ts), kept its claim
and lost its reasoning: nothing schedules a payout, and that is a product
decision rather than a missing scheduler — the CronJob *finishes* a claimed
payout and never *initiates* one. ADR 0031's return-expiry passage went the
same way: the argument was "nowhere to run a schedule", and now that there is
somewhere, expiring a dispute by clock is still wrong.

## 4. What this does not do

**No Helm chart.** Kustomize overlays, for the reason in ADR 0032.

**No Strimzi.** One broker does not need an operator, and the messaging overlay
is optional anyway.

**No horizontal pod autoscaling.** It needs load data this project does not
have. The measured figures in
[plan 0001 §5](0001-multi-channel-notifications.md) are consumer throughput, not
request throughput.

**No service mesh, no cert-manager, no external-dns.** Each is a real thing a
real cluster wants and none of them is this application's problem.

**No production cluster.** Everything is verified on kind. A manifest that
applies cleanly locally can still be wrong about a cloud load balancer, and
saying otherwise would be the kind of claim this repository avoids.

## 5. Open questions

1. **Liveness for the relay and the worker.** Neither serves HTTP. ADR 0023
   suggested consumer lag at `/health/lag`; that endpoint is on the API, so
   either the workers grow a port or the probe becomes an `exec` against their
   own lag. Unsolved, and only affects the messaging overlay.
2. **Where the Stripe webhook lands.** It is the one inbound path that is not a
   browser, and ADR 0032 gives the API no Ingress. Either the Ingress grows one
   path that bypasses the BFF, or Next proxies webhooks too — which means a
   signature-verified body passing through a second process.
3. **Whether MinIO belongs in-cluster at all.** It is right for kind. In a cloud
   it is a bucket, and the only reason to run it is to avoid depending on one.

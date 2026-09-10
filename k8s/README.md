# Kubernetes

Compose is the development story. This is the deployment one, and it exists for
the two things Compose cannot do: promote a dead primary, and run something on a
schedule.

Decisions and their rejected alternatives are in
[ADR 0032](../docs/adr/0032-kubernetes-manifests.md); what each phase cost is in
[plan 0004](../docs/plans/0004-kubernetes.md).

```
base/                   the application, and nothing environment-specific
  postgres-cluster.yaml a CloudNativePG Cluster, not a StatefulSet we maintain
  api.yaml              Deployment + ClusterIP. No Ingress, deliberately
  web.yaml              Deployment + ClusterIP: the UI and the BFF
  redis.yaml            no persistence, on purpose
  minio.yaml            local convenience; in a cloud this is a bucket
  migrate-job.yaml      one-shot, with an initContainer that waits for Postgres
  payout-cronjob.yaml   the ONE scheduled job in the system
  ingress.yaml          one rule, to web
overlays/
  local/                kind: NodePort instead of Ingress, one of everything
  messaging/            kafka + relay + worker (not written yet)
kind-cluster.yaml       one node, port 30000 mapped to the host
```

## Running it on kind

Needs `docker`, `kubectl`, and `kind`. The operator is a prerequisite rather
than a bundled file — `kubectl apply -k` on a cluster without the CRDs fails on
an unknown kind, which is a better failure than a hand-rolled StatefulSet that
comes up and cannot fail over.

```bash
kind create cluster --name retailstore-2n --config k8s/kind-cluster.yaml

kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.30.0/releases/cnpg-1.30.0.yaml
kubectl -n cnpg-system wait --for=condition=Available deployment/cnpg-controller-manager --timeout=180s

# kind has no registry, so the images have to be loaded into the node.
docker build --target api        -t retailstore-2n-api:local .
docker build --target web        -t retailstore-2n-web:local .
docker build --target api-build  -t retailstore-2n-migrate:local .
for i in api web migrate; do kind load docker-image retailstore-2n-$i:local --name retailstore-2n; done

kubectl apply -k k8s/overlays/local
```

The storefront is then on <http://localhost:30000>. Seeding is not a manifest —
it is a one-off, the same as `docker compose --profile tools run --rm seed`:

```bash
kubectl -n retailstore-2n create job seed --image=retailstore-2n-migrate:local -- npx prisma db seed
```

## What is actually verified, and what is not

Everything below was run on a one-node kind cluster, not asserted from reading
the YAML.

| Verified | |
| --- | --- |
| Cold-start `apply -k` | 17 resources; the `migrate` Job completes; every migration applies |
| The storefront | serves a real seeded listing through browser → NodePort → BFF → api → Postgres |
| **Failover** | primary pod deleted, CloudNativePG promoted the replica, and a **write** then succeeded with **0 API restarts** |
| The CronJob | settled a payout stranded at `PENDING`; two concurrent Jobs produced **one** transfer |

| Not verified | |
| --- | --- |
| Any real cluster | A manifest that applies on kind can still be wrong about a cloud load balancer, an ingress class, or a storage class |
| Backups | `barmanObjectStore` is where retention belongs and no overlay configures it — see [hld.md](../docs/architecture/hld.md) limitations |
| The messaging overlay | Not written. The base runs `NOTIFY_TRANSPORT=inline` with no relay and no worker, because on inline the relay is a function call inside the API |
| Liveness for relay/worker | Neither serves HTTP. Open question 1 in plan 0004 |
| Where the Stripe webhook lands | The API has no Ingress by design. Open question 2 in plan 0004 |

## Two things that cost a deployment to find

Both are the sort of thing reading the YAML would not have caught, and both are
commented where they live rather than only here.

**A generated Secret's name never reached the CNPG `Cluster`.** `secretGenerator`
appends a content hash so that changing a credential rolls the pods reading it,
and kustomize then rewrites every *known* reference. `Cluster` is a CRD, so it
does not know `spec.bootstrap.initdb.secret.name` is one — the bootstrap pod
failed with `CreateContainerConfigError`, a message that says nothing about
names. Fixed by teaching the transformer that one field in
[`base/kustomizeconfig.yaml`](base/kustomizeconfig.yaml), rather than by
`disableNameSuffixHash`, which fixes it by giving up the feature.

**The `migrate` Job fired before Postgres existed.** Compose expressed this as
`depends_on: condition: service_healthy`; Kubernetes has no equivalent for a
Job. It hit `P1001: Can't reach database server` three times and went `Failed`
while the operator was still bootstrapping. `kubectl apply -k` succeeding is not
the same as the stack coming up. Fixed with an initContainer that TCP-polls
`postgres-rw:5432` — a connect is the right check because CNPG's `-rw` Service
has no endpoints until an instance is primary and ready.

## Why there is only one CronJob

Kubernetes has CronJobs, so the obvious move is to take the API's five
`setInterval` sweepers and make each a CronJob. That would be a regression, and
ADR 0032 exists mostly to say why: the sweepers claim work with a conditional
`UPDATE`, so N API replicas *divide* it, and one CronJob would serialise it.
They also run continuously rather than on a cadence, which is what recovering
an expired reservation wants.

The scheduled job is `payouts:pending`, and it is scheduled because it moves
money to a third party — a Job has an exit code, a start time and a record,
where a loop inside the process serving checkout has application logs.

Every job is runnable by hand, which is what an operator wants after an
incident:

```bash
kubectl -n retailstore-2n create job fix --from=cronjob/payouts-pending
# or, in either deployment:
node dist/jobs.js --list
```

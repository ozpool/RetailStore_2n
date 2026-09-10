#!/usr/bin/env bash
#
# Kills the Postgres primary and counts what that cost.
#
# WHAT IS BEING CLAIMED
# ADR 0020 built physical replication in Compose and said plainly that nothing
# there promotes a standby. ADR 0032 replaced it with a CloudNativePG Cluster.
# The claim is that two numbers hold:
#
#   requests lost after recovery   0   the -rw Service follows the new primary
#   API restarts needed            0   Prisma's pool reconnects on its own
#
# Those are the two halves of one trade. A pool that cached the old primary's
# address would need a restart, and a restart is a thing an orchestrator can do
# for you — which would make this demo pass while hiding the interesting part.
# So the restart count is measured, not assumed.
#
# WHY DELETING THE POD IS A FAIR TEST
# It is not a clean switchover: `cnpg promote` would ask the operator to move
# the primary in an orderly way, which is not what a dead node does. Deleting
# the pod leaves the PVC behind, so the instance tries to come back and fails,
# and the operator has to decide to promote the other one. That is the case the
# design is defending against.
#
# HOW A LOST WRITE WOULD BE DETECTED
# Not by watching the storefront return 200 — a cached page does that with no
# database at all. A row is INSERTed through the BFF after failover and then
# read back out of the new primary by name.
#
#   ./k8s/failover-demo.sh
#
# See docs/adr/0020-replication-and-backups.md and docs/adr/0032-kubernetes-manifests.md
set -uo pipefail

NS=retailstore-2n
WEB=${WEB:-http://localhost:30000}
W=72
rule() { printf '%*s\n' "$W" '' | tr ' ' "${1:--}"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "  $1 is not installed."; exit 2; }; }
need kubectl
need curl

primary() { kubectl -n "$NS" get cluster postgres -o jsonpath='{.status.currentPrimary}' 2>/dev/null; }
phase()   { kubectl -n "$NS" get cluster postgres -o jsonpath='{.status.phase}' 2>/dev/null; }
ready()   { kubectl -n "$NS" get cluster postgres -o jsonpath='{.status.readyInstances}' 2>/dev/null; }
restarts(){ kubectl -n "$NS" get pods -l app=api -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null; }
code()    { curl -s -o /dev/null -w '%{http_code}' -m 8 "$WEB/" 2>/dev/null; }

kubectl -n "$NS" get cluster postgres >/dev/null 2>&1 || {
  echo
  echo "  No Postgres cluster in namespace '$NS'."
  echo "  Bring the stack up first — see k8s/README.md."
  echo
  exit 2
}

if [ "$(ready)" != "2" ]; then
  echo
  echo "  This needs TWO instances; there is/are $(ready)."
  echo "  A single-instance cluster has nothing to promote:"
  echo
  echo "    kubectl -n $NS patch cluster postgres --type merge -p '{\"spec\":{\"instances\":2}}'"
  echo
  exit 2
fi

echo
rule '='
echo "THE POSTGRES PRIMARY, DELETED"
rule '='
BEFORE_PRIMARY=$(primary)
BEFORE_RESTARTS=$(restarts)
echo "  primary        $BEFORE_PRIMARY"
echo "  instances      $(ready) ready"
echo "  api restarts   $BEFORE_RESTARTS  (the number that must not change)"
echo "  storefront     $(code)"
rule '='

# A row written BEFORE the failure, to prove afterwards that committed data
# survived rather than that the database merely came back.
MARK="failover-before-$(date +%s)@retailstore-2n.test"
curl -s -m 20 -X POST "$WEB/api/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Before\",\"email\":\"$MARK\",\"password\":\"correct horse battery staple 9\"}" \
  -o /dev/null -w '  wrote a row before the kill: HTTP %{http_code}\n'

rule
echo "Deleting pod/$BEFORE_PRIMARY"
kubectl -n "$NS" delete pod "$BEFORE_PRIMARY" --wait=false >/dev/null 2>&1

DOWN=0
PROMOTED=""
START=$(date +%s)
for i in $(seq 1 40); do
  sleep 6
  C=$(code); P=$(primary); PH=$(phase)
  [ "$C" != "200" ] && DOWN=$((DOWN + 1))
  printf '  t+%-4ss primary=%-12s phase=%-26s store=%s\n' "$(( $(date +%s) - START ))" "$P" "$PH" "$C"
  if [ -n "$P" ] && [ "$P" != "$BEFORE_PRIMARY" ] && [ "$PH" = "Cluster in healthy state" ]; then
    PROMOTED="$P"; break
  fi
done

ELAPSED=$(( $(date +%s) - START ))
rule

if [ -z "$PROMOTED" ]; then
  echo "  NO PROMOTION after ${ELAPSED}s. Not a pass."
  echo "  Check: kubectl -n $NS get cluster postgres -o yaml | grep -A5 phase"
  exit 1
fi

echo "Promoted: $BEFORE_PRIMARY -> $PROMOTED after ${ELAPSED}s"

# The real test: a WRITE, after failover, through the whole stack.
AFTER="failover-after-$(date +%s)@retailstore-2n.test"
AFTER_CODE=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X POST "$WEB/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"After\",\"email\":\"$AFTER\",\"password\":\"correct horse battery staple 9\"}")

Q="SELECT count(*) FROM users WHERE email IN ('$MARK','$AFTER');"
SURVIVED=$(kubectl -n "$NS" exec "$PROMOTED" -c postgres -- \
  psql -U postgres -d retailstore_2n -tAc "$Q" 2>/dev/null | tr -d '[:space:]')
kubectl -n "$NS" exec "$PROMOTED" -c postgres -- \
  psql -U postgres -d retailstore_2n -tAc "DELETE FROM users WHERE email IN ('$MARK','$AFTER');" >/dev/null 2>&1

AFTER_RESTARTS=$(restarts)

echo
rule '='
echo "WHAT IT COST"
rule '='
printf '  promotion took           %ss\n' "$ELAPSED"
printf '  polls with a bad status  %s of the window\n' "$DOWN"
printf '  write after failover     HTTP %s\n' "$AFTER_CODE"
printf '  rows found in the new primary  %s of 2  (one written before, one after)\n' "$SURVIVED"
printf '  api restarts             %s -> %s\n' "$BEFORE_RESTARTS" "$AFTER_RESTARTS"
rule '='

if [ "$AFTER_CODE" = "201" ] && [ "$SURVIVED" = "2" ] && [ "$AFTER_RESTARTS" = "$BEFORE_RESTARTS" ]; then
  echo "  PASS  promoted, committed data intact, and the API reconnected itself."
else
  echo "  FAIL  see the numbers above."
  rule '='
  exit 1
fi
rule '='
echo
echo "  NOT PROVEN HERE: the storefront was unavailable during the window above,"
echo "  and that is honest rather than hidden — a promotion is an outage, just a"
echo "  short and automatic one. Nothing here makes it invisible to a buyer."
echo

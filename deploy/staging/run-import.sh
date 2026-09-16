#!/bin/bash
# Imports a split export into staging, in order: base with --replace-all, then
# every chunk with --append. Waits for Convex memory to settle between chunks
# and stops at the first failure. Memory is logged every 10 seconds.
set -uo pipefail
DIR=${1:?directory with 00-base.zip and chunks}
cd /opt/ta-staging-src
AK=$(grep ^CONVEX_SELF_HOSTED_ADMIN_KEY= .env.staging | cut -d= -f2-)
CLI="node node_modules/convex/bin/main.js"
( while true; do echo "$(date -u +%H:%M:%S) $(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' ta-staging-convex ta-staging-postgres | tr '\n' ' ') host_avail=$(free -m | awk '/Mem:/{print $7}')MB"; sleep 10; done ) > "$DIR/memory.log" 2>&1 &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT
step() { echo "== $(date -u +%H:%M:%S) $1"; }
settle() {
  for i in $(seq 1 60); do
    used=$(docker stats --no-stream --format '{{.MemUsage}}' ta-staging-convex | awk '{print $1}')
    case "$used" in *GiB) gib=${used%GiB};; *MiB) gib=0;; *) gib=9;; esac
    awk -v g="$gib" 'BEGIN{exit !(g < 4)}' && return 0
    sleep 10
  done
}
files="$DIR/00-base.zip $(ls $DIR/cand-*.zip 2>/dev/null) $(ls $DIR/cr-*.zip 2>/dev/null)"
for f in $files; do
  mode="--append"; [[ "$f" == *00-base.zip ]] && mode="--replace-all"
  step "import $(basename $f) $mode"
  ok=0
  for attempt in 1 2 3; do
    if $CLI import "$f" $mode --yes --url http://127.0.0.1:3220 --admin-key "$AK"; then ok=1; break; fi
    step "attempt $attempt failed for $(basename $f); waiting for the backend"
    for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:3220/version && break; sleep 5; done
    sleep 30
    [ "$mode" = "--replace-all" ] || break
  done
  [ $ok = 1 ] || { step "FAILED on $(basename $f)"; exit 1; }
  echo "$(basename $f)" >> "$DIR/imported.txt"
  settle
done
step "ALL DONE"

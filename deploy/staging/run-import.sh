#!/bin/bash
# Imports a split export into staging: base with --replace-all, then every chunk
# with --append. Convex keeps the memory it used to build search indexes, so
# after a chunk that leaves it above 3 GiB the staging Convex container is
# restarted (data lives in Postgres; nothing is lost) before the next one.
# Chunks already listed in imported.txt are skipped, so the script can resume.
set -uo pipefail
DIR=${1:?directory with 00-base.zip and chunks}
cd /opt/ta-staging-src
AK=$(grep ^CONVEX_SELF_HOSTED_ADMIN_KEY= .env.staging | cut -d= -f2-)
CLI="node node_modules/convex/bin/main.js"
( while true; do echo "$(date -u +%H:%M:%S) $(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' ta-staging-convex ta-staging-postgres | tr '\n' ' ') host_avail=$(free -m | awk '/Mem:/{print $7}')MB"; sleep 10; done ) >> "$DIR/memory.log" 2>&1 &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT
step() { echo "== $(date -u +%H:%M:%S) $1"; }
wait_backend() {
  for i in $(seq 1 120); do curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3220/version && return 0; sleep 5; done
  return 1
}
relieve() {
  used=$(docker stats --no-stream --format '{{.MemUsage}}' ta-staging-convex | awk '{print $1}')
  case "$used" in *GiB) gib=${used%GiB};; *) gib=0;; esac
  if awk -v g="$gib" 'BEGIN{exit !(g >= 3)}'; then
    step "convex at ${used}; restarting it to release memory"
    docker restart -t 30 ta-staging-convex >/dev/null
    wait_backend || { step "backend did not come back"; exit 1; }
    sleep 45
  fi
}
touch "$DIR/imported.txt"
files="$DIR/00-base.zip $(ls $DIR/cand-*.zip 2>/dev/null) $(ls $DIR/cr-*.zip 2>/dev/null)"
for f in $files; do
  name=$(basename "$f")
  grep -qx "$name" "$DIR/imported.txt" && continue
  mode="--append"; [[ "$name" == 00-base.zip ]] && mode="--replace-all"
  relieve
  step "import $name $mode"
  if ! $CLI import "$f" $mode --yes --url http://127.0.0.1:3220 --admin-key "$AK"; then
    step "import of $name failed; restarting backend and retrying once"
    docker restart -t 30 ta-staging-convex >/dev/null; wait_backend; sleep 45
    $CLI import "$f" $mode --yes --url http://127.0.0.1:3220 --admin-key "$AK" || { step "FAILED on $name"; exit 1; }
  fi
  echo "$name" >> "$DIR/imported.txt"
done
step "ALL DONE"

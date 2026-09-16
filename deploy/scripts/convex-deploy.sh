#!/usr/bin/env bash
# Deploys the Convex side of the TA System from the CI runner.
#
# The backend is only on the server's loopback address, so it is reached
# through an SSH tunnel (host alias `deploy-target`, set up by the workflow).
# Through the tunnel it is 127.0.0.1 — the same rule scripts/convex-local-only.mjs
# enforces for people: the CLI is only ever pointed at a loopback address.
#
# In order, so a deployment never runs with the wrong switches:
#   1. settings pinned in deploy/convex-env/<env>.env are set (non-secret
#      values only — e.g. staging's crons-off and outbound-lock switches)
#   2. every name in deploy/convex-env/<env>.required must be set on the
#      deployment (secrets are managed on the deployment, never in git or CI)
#   3. `convex deploy`: typechecks, pushes the schema and the functions. Convex
#      checks the schema against the data already stored and refuses the whole
#      deploy if a document would not fit, so a breaking schema change fails
#      here and the previous functions keep running.
#   4. RUN_FUNCTION, if given (a one-off migration)
#   5. smoke checks
#
# Needs: CONVEX_SELF_HOSTED_ADMIN_KEY, CONVEX_REMOTE_PORT, DEPLOY_ENV.
# Values of settings are never printed.
set -euo pipefail

: "${CONVEX_SELF_HOSTED_ADMIN_KEY:?the admin key for this environment is not set}"
: "${CONVEX_REMOTE_PORT:?}"
: "${DEPLOY_ENV:?}"

LOCAL_PORT=13210
SOCKET="$(mktemp -u)"
ssh -M -S "$SOCKET" -f -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${CONVEX_REMOTE_PORT}" deploy-target
trap 'ssh -S "$SOCKET" -O exit deploy-target >/dev/null 2>&1 || true' EXIT

export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:${LOCAL_PORT}"
for i in $(seq 1 20); do
  curl -fs -o /dev/null "$CONVEX_SELF_HOSTED_URL/version" && break
  [ "$i" = 20 ] && { echo "::error::The Convex backend did not answer through the tunnel."; exit 1; }
  sleep 1
done

case "$CONVEX_SELF_HOSTED_URL" in
  http://127.0.0.1:*) ;;
  *) echo "::error::Refusing a non-loopback Convex URL."; exit 1 ;;
esac
cli() { npx --no-install convex "$@"; }

# Current settings, held in memory only — values are never printed.
listing="$(cli env list)"
declare -A CURRENT=()
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  CURRENT["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
done <<< "$listing"
unset listing

# ── 1. Pinned settings ─────────────────────────────────────────────────────────
PINS="deploy/convex-env/${DEPLOY_ENV}.env"
if [ -f "$PINS" ]; then
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%%#*}"; line="$(echo "$line" | xargs)"
    [ -z "$line" ] && continue
    name="${line%%=*}"; value="${line#*=}"
    if [ "${CURRENT[$name]-__unset__}" != "$value" ]; then
      echo "Setting $name=$value"
      cli env set "$name" "$value" >/dev/null
      CURRENT["$name"]="$value"
    else
      echo "$name already $value"
    fi
  done < "$PINS"
fi

# ── 2. Required settings ───────────────────────────────────────────────────────
REQUIRED="deploy/convex-env/${DEPLOY_ENV}.required"
missing=()
forbidden=()
if [ -f "$REQUIRED" ]; then
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%%#*}"; line="$(echo "$line" | xargs)"
    [ -z "$line" ] && continue
    if [[ "$line" == !* ]]; then
      name="${line#!}"
      [ -n "${CURRENT[$name]-}" ] && forbidden+=("$name")
    elif [[ "$line" == *"|"* ]]; then
      # a|b|c — at least one of them
      found=""
      IFS='|' read -ra alts <<< "$line"
      for n in "${alts[@]}"; do [ -n "${CURRENT[$n]-}" ] && found=1; done
      [ -z "$found" ] && missing+=("$line")
    else
      [ -z "${CURRENT[$line]-}" ] && missing+=("$line")
    fi
  done < "$REQUIRED"
fi
if [ ${#missing[@]} -gt 0 ] || [ ${#forbidden[@]} -gt 0 ]; then
  [ ${#missing[@]} -gt 0 ] && echo "::error::Not set on the ${DEPLOY_ENV} Convex deployment: ${missing[*]} (set with: npx convex env set NAME value, or the dashboard)"
  [ ${#forbidden[@]} -gt 0 ] && echo "::error::Must not be set on the ${DEPLOY_ENV} Convex deployment: ${forbidden[*]}"
  exit 1
fi
echo "Required settings present."

# ── 3. Schema and functions ────────────────────────────────────────────────────
cli deploy --yes

# ── 4. One-off function ────────────────────────────────────────────────────────
if [ -n "${RUN_FUNCTION:-}" ]; then
  echo "Running $RUN_FUNCTION"
  cli run "$RUN_FUNCTION" "${RUN_ARGS:-"{}"}"
fi

# ── 5. Smoke checks ────────────────────────────────────────────────────────────
# The TA functions read and write anything and must stay internal.
reply=$(curl -s -X POST "$CONVEX_SELF_HOSTED_URL/api/query" -H 'content-type: application/json' \
  -d '{"path":"ta/storage:safetyState","args":{},"format":"json"}')
if ! grep -q "Could not find public function" <<< "$reply"; then
  echo "::error::ta/storage:safetyState answered a public call — the TA functions are not internal."
  exit 1
fi
echo "TA functions are internal."

if [ "$DEPLOY_ENV" != "production" ]; then
  # Printed as JSON or as a JS object depending on the CLI version; compare without quotes.
  state=$(cli run ta/storage:safetyState '{}' | tr -d ' \n"')
  if [[ "$state" != *'cronsDisabled:true'* ]] || [[ "$state" != *'outboundLocked:true'* ]]; then
    echo "::error::${DEPLOY_ENV} is not in the safe state (crons off, outbound locked): $state"
    exit 1
  fi
  echo "Crons off and outbound locked."
fi

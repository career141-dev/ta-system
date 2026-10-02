#!/bin/sh
# Starts the TA website on http://localhost:3100 against the LOCAL backend only.
# Values here override .env.local, so a live address in that file is never used.
cd "$(dirname "$0")/../.." || exit 1
set -a; . deploy/local/.env.backend.local; set +a
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${LOCAL_CONVEX_PORT:-3210}
export CONVEX_URL=http://127.0.0.1:${LOCAL_CONVEX_PORT:-3210}
export NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:${LOCAL_CONVEX_PORT:-3210}
export NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:${LOCAL_CONVEX_SITE_PORT:-3211}
export CONVEX_SELF_HOSTED_ADMIN_KEY="$LOCAL_ADMIN_KEY"
export QDRANT_URL=http://127.0.0.1:6333
export QDRANT_API_KEY="$LOCAL_QDRANT_API_KEY"
export C141_SESSION_SECRET="$LOCAL_SESSION_SECRET"
export C141_STORE=convex
export C141_DEV_SIGNIN=on
unset C141_DEPLOYMENT C141_CONVEX_HOST C141_DATA_DIR
exec npx next dev -p "${PORT:-3100}" --webpack

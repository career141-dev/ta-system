#!/bin/sh
# For screen (UI) work only: the website with invented sample data, no backend,
# no real sign-in. Pick a test account on the sign-in page. Nothing real is used.
cd "$(dirname "$0")/../.." || exit 1
export C141_DATA_DIR="$PWD/.data-ui"
unset CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
export C141_STORE=json C141_TEST_RUN=1 C141_DEV_SIGNIN=on C141_UI_ONLY=on NEXT_PUBLIC_C141_UI_ONLY=on
export C141_SESSION_SECRET="${C141_SESSION_SECRET:-local-ui-only-$(openssl rand -hex 8)}"
# Placeholder sign-in keys in the right shape; they unlock nothing.
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_$(printf 'example.clerk.accounts.dev$' | base64)"
export CLERK_SECRET_KEY=sk_test_localuionly
exec npx next dev -p 3100 --webpack

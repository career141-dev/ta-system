#!/usr/bin/env bash
# Runs ON THE SERVER. Replaces the app container with a new image and rolls
# back if the new one never becomes healthy.
#
#   remote-app.sh <deploy_dir> <env_file> <service> <container> <image> <health_url> <channel>
#
# Reads two lines on stdin: the registry user and a short-lived registry token
# (the workflow's own token, valid only while the job runs). A token of "-"
# skips the registry: for putting back an image already on the server by hand,
#   printf -- '-\n-\n' | bash .deploy/remote-app.sh ... <image> ...
#
# Only the app service is touched (`--no-deps`): Convex, Postgres and Qdrant keep
# running. The compose file reads the image from TA_APP_IMAGE.
set -euo pipefail

DIR="$1"; ENV_FILE="$2"; SERVICE="$3"; CONTAINER="$4"; IMAGE="$5"; HEALTH_URL="$6"; CHANNEL="$7"
REPO="${IMAGE%:*}"

read -r GHCR_USER
read -r GHCR_TOKEN

cd "$DIR"
mkdir -p .deploy

compose() { docker compose --env-file "$ENV_FILE" "$@"; }

previous="$(cat .deploy/app-image 2>/dev/null || docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
echo "Current image: ${previous:-none}"
echo "New image:     $IMAGE"

# Images are tagged by commit and never overwritten, so one already here is the right one.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ "$GHCR_TOKEN" = "-" ]; then
    echo "::error::$IMAGE is not on the server and no registry token was given."
    exit 1
  fi
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  docker pull -q "$IMAGE"
  docker logout ghcr.io >/dev/null 2>&1 || true
fi

wait_healthy() {
  # The container's own health check first (start period 60s, every 30s), then
  # the page through the published port.
  for _ in $(seq 1 48); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
    case "$status" in
      healthy)
        curl -fs -o /dev/null --max-time 20 "$HEALTH_URL" && return 0 ;;
      unhealthy|exited|dead|missing)
        return 1 ;;
    esac
    sleep 5
  done
  return 1
}

TA_APP_IMAGE="$IMAGE" compose up -d --no-deps "$SERVICE"

if ! wait_healthy; then
  echo "::error::The new app did not become healthy. Last log lines:"
  docker logs --tail 60 "$CONTAINER" 2>&1 || true
  if [ -n "$previous" ] && [ "$previous" != "$IMAGE" ] && docker image inspect "$previous" >/dev/null 2>&1; then
    echo "Rolling back to $previous"
    TA_APP_IMAGE="$previous" compose up -d --no-deps "$SERVICE"
    wait_healthy && echo "Rolled back; the previous version is running." || echo "::error::The previous version is not healthy either."
  fi
  exit 1
fi

echo "$IMAGE" > .deploy/app-image
# A plain `docker compose up` on the server (without TA_APP_IMAGE) starts this version too.
docker tag "$IMAGE" "$REPO:$CHANNEL"
echo "Healthy: $IMAGE"

# Keep the running image, the one before it, and the three newest; the disk is shared with production.
docker images "$REPO" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' \
  | { grep -P "\t\Q$REPO\E:\Q$CHANNEL\E-" || true; } | sort -r | tail -n +4 | cut -f2 \
  | while read -r old; do
      [ "$old" = "$IMAGE" ] || [ "$old" = "$previous" ] || docker rmi "$old" >/dev/null 2>&1 || true
    done
exit 0

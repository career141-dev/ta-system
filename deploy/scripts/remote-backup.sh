#!/usr/bin/env bash
# Runs ON THE SERVER before a Convex deploy. Dumps the Postgres database that
# holds the Convex deployment, so a bad schema change or migration can be undone
# by restoring it.
#
#   remote-backup.sh <environment> <postgres_container> <postgres_user> <database> <commit>
#
# Refuses to start when the disk is too full to hold another copy — the disk is
# shared with the live system. Keeps the newest seven dumps per environment.
set -euo pipefail

ENVIRONMENT="$1"; CONTAINER="$2"; PGUSER="$3"; DB="$4"; COMMIT="${5:0:12}"
DIR="/opt/backups/ta-${ENVIRONMENT}"
mkdir -p "$DIR" && chmod 700 "$DIR"

db_bytes="$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$DB" -Atc "select pg_database_size('$DB')")"
free_bytes="$(df --output=avail -B1 "$DIR" | tail -1)"
# A compressed dump is smaller than the database; ask for the database size plus 5 GB headroom.
if [ "$free_bytes" -lt $((db_bytes + 5 * 1024 * 1024 * 1024)) ]; then
  echo "::error::Not enough disk for a backup: $((free_bytes / 1024 / 1024)) MB free, database $((db_bytes / 1024 / 1024)) MB."
  exit 1
fi

file="$DIR/convex-$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT}.dump"
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$DB" -Fc > "$file.partial"
mv "$file.partial" "$file"
chmod 600 "$file"
echo "Backup: $file ($(du -h "$file" | cut -f1))"

ls -1t "$DIR"/convex-*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f

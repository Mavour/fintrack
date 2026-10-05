#!/usr/bin/env bash
# Daily SQLite backup via cron: 0 2 * * * /opt/dompet/scripts/backup.sh
set -euo pipefail
DB="${DATABASE_PATH:-./data/app.db}"
DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$DIR"
STAMP=$(date +%F)
sqlite3 "$DB" ".backup '$DIR/app-$STAMP.db'"
ls -t "$DIR"/app-*.db | tail -n +15 | xargs -r rm --
echo "backup ok: $DIR/app-$STAMP.db"

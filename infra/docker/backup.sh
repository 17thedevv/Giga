#!/bin/sh
# Usage: sh infra/docker/backup.sh [--local] [--env-file PATH] OUTPUT.dump
# No cloud or provider call; never overwrites an existing archive.
set -eu
umask 077
GIGA_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "${1:-}" in --help|-h) echo 'Usage: backup.sh [--local] [--env-file PATH] OUTPUT.dump'; exit 0;; esac
# Resolve caller-relative archive/env paths before changing directory.
GIGA_CALLER=$PWD
. "$GIGA_ROOT/infra/docker/postgres/compose-command.sh"
giga_backup_arguments "$@"
case "$GIGA_ARCHIVE" in /*) ;; *) GIGA_ARCHIVE=$GIGA_CALLER/$GIGA_ARCHIVE;; esac
case "$GIGA_ENV_FILE" in /*) ;; *) GIGA_ENV_FILE=$GIGA_CALLER/$GIGA_ENV_FILE;; esac
cd "$GIGA_ROOT"
set -C
if giga_compose exec -T postgres sh -ceu '
  export PGPASSWORD="$DB_PASSWORD_ADMIN"
  exec pg_dump --host=127.0.0.1 --username=giga_admin --dbname=giga --no-password --format=custom --compress=6
' > "$GIGA_ARCHIVE"; then
  echo "PostgreSQL custom archive written: $GIGA_ARCHIVE"
  echo 'Archive includes private data; keep it outside Git and protect it as a secret.'
else
  echo 'Backup failed; any newly created archive is incomplete and must not be used.' >&2
  exit 1
fi

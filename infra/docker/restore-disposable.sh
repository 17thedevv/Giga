#!/bin/sh
# Usage: sh infra/docker/restore-disposable.sh [--local] [--env-file PATH] INPUT.dump
# Restores ONLY into a newly generated disposable database in this local cluster.
# Does not drop databases, overwrite existing data, or change the configured giga DB.
set -eu
GIGA_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "${1:-}" in --help|-h) echo 'Usage: restore-disposable.sh [--local] [--env-file PATH] INPUT.dump'; exit 0;; esac
GIGA_CALLER=$PWD
. "$GIGA_ROOT/infra/docker/postgres/compose-command.sh"
giga_backup_arguments "$@"
case "$GIGA_ARCHIVE" in /*) ;; *) GIGA_ARCHIVE=$GIGA_CALLER/$GIGA_ARCHIVE;; esac
case "$GIGA_ENV_FILE" in /*) ;; *) GIGA_ENV_FILE=$GIGA_CALLER/$GIGA_ENV_FILE;; esac
[ -f "$GIGA_ARCHIVE" ] && [ -s "$GIGA_ARCHIVE" ] || { echo 'A non-empty PostgreSQL custom archive is required.' >&2; exit 2; }
cd "$GIGA_ROOT"

# Derive a server-generated identifier: callers cannot choose or override target.
GIGA_RESTORE_SUFFIX=$(giga_compose exec -T postgres psql --username=giga_admin --dbname=postgres --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --command "SELECT replace(gen_random_uuid()::text, '-', '');")
case "$GIGA_RESTORE_SUFFIX" in ''|*[!0-9a-f]*) echo 'Failed to generate a safe disposable database name.' >&2; exit 1;; esac
[ "${#GIGA_RESTORE_SUFFIX}" -eq 32 ] || { echo 'Invalid disposable database suffix.' >&2; exit 1; }
GIGA_RESTORE_DB=giga_restore_test_$GIGA_RESTORE_SUFFIX

# createdb fails if a database exists. No --clean, DROP, target argument, or
# caller-supplied SQL is accepted. Ownership/ACLs are preserved from the dump;
# original cluster roles already exist because bootstrap created them.
giga_compose exec -T postgres createdb --username=giga_admin --owner=giga_migration --template=template0 "$GIGA_RESTORE_DB"
# A normal pg_dump does not recreate database-level connection privileges.
giga_compose exec -T postgres psql --username=giga_admin --dbname=postgres --no-psqlrc --set ON_ERROR_STOP=1 --set restore_db="$GIGA_RESTORE_DB" <<'SQL'
REVOKE ALL ON DATABASE :"restore_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"restore_db" TO giga_runtime, giga_lifecycle, giga_quota;
SQL
if giga_compose exec -T postgres pg_restore --username=giga_admin --dbname="$GIGA_RESTORE_DB" --single-transaction --exit-on-error < "$GIGA_ARCHIVE"; then
  echo 'Restore completed into a fresh disposable database; configured application database is unchanged.'
  echo 'Recheck application-role grants and test data before considering any recovery successful.'
  echo "$GIGA_RESTORE_DB"
else
  echo "Restore failed; disposable database retained for inspection: $GIGA_RESTORE_DB" >&2
  exit 1
fi

#!/bin/sh
# Shared by backup.sh and restore-disposable.sh; run those scripts from any cwd.
giga_backup_arguments() {
  GIGA_ENV_FILE=${GIGA_COMPOSE_ENV:-.env}
  GIGA_USE_LOCAL=${GIGA_LOCAL_HTTP:-0}
  GIGA_ARCHIVE=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --local) GIGA_USE_LOCAL=1; shift;;
      --env-file)
        [ "$#" -ge 2 ] || { echo '--env-file requires a path.' >&2; return 2; }
        GIGA_ENV_FILE=$2; shift 2;;
      --*) echo "Unknown option: $1" >&2; return 2;;
      *)
        [ -z "$GIGA_ARCHIVE" ] || { echo 'Specify exactly one archive path.' >&2; return 2; }
        GIGA_ARCHIVE=$1; shift;;
    esac
  done
  [ -n "$GIGA_ARCHIVE" ] || { echo 'An archive path is required.' >&2; return 2; }
  [ -f "$GIGA_ENV_FILE" ] || { echo 'Compose environment file does not exist.' >&2; return 2; }
  command -v docker >/dev/null 2>&1 || { echo 'Docker with Compose v2 is required.' >&2; return 2; }
}

giga_compose() {
  if [ "$GIGA_USE_LOCAL" = 1 ]; then
    docker compose --env-file "$GIGA_ENV_FILE" -f compose.yaml -f infra/docker/compose.local.yaml "$@"
  else
    docker compose --env-file "$GIGA_ENV_FILE" -f compose.yaml "$@"
  fi
}

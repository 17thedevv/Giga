#!/bin/sh
# Invoked by the official PostgreSQL entrypoint ONLY for an empty data volume.
# Passwords are supplied at runtime; no generated values belong in this file.
set -eu

if [ "${POSTGRES_USER:-}" != giga_admin ] || [ "${POSTGRES_DB:-}" != giga ]; then
  echo 'Giga initialization requires POSTGRES_USER=giga_admin and POSTGRES_DB=giga.' >&2
  exit 1
fi

for name in DB_PASSWORD_ADMIN DB_PASSWORD_MIGRATION DB_PASSWORD_API DB_PASSWORD_LIFECYCLE DB_PASSWORD_QUOTA; do
  # These names are fixed by this script, never supplied by a caller.
  eval "value=\${$name:-}"
  case "$value" in ''|*[!a-fA-F0-9]*) echo "$name must contain 32-128 hexadecimal characters." >&2; exit 1;; esac
  if [ "${#value}" -lt 32 ] || [ "${#value}" -gt 128 ]; then
    echo "$name must contain 32-128 hexadecimal characters." >&2
    exit 1
  fi
done
if [ "${POSTGRES_PASSWORD:-}" != "$DB_PASSWORD_ADMIN" ]; then
  echo 'POSTGRES_PASSWORD must match DB_PASSWORD_ADMIN.' >&2
  exit 1
fi
if [ "$(printf '%s\n' "$DB_PASSWORD_ADMIN" "$DB_PASSWORD_MIGRATION" "$DB_PASSWORD_API" "$DB_PASSWORD_LIFECYCLE" "$DB_PASSWORD_QUOTA" | sort -u | wc -l | tr -d ' ')" != 5 ]; then
  echo 'All five PostgreSQL credentials must be distinct.' >&2
  exit 1
fi

# psql reads credentials directly from the environment rather than command-line
# arguments. ON_ERROR_STOP prevents a partial initialization from looking healthy.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password DB_PASSWORD_MIGRATION
\getenv api_password DB_PASSWORD_API
\getenv lifecycle_password DB_PASSWORD_LIFECYCLE
\getenv quota_password DB_PASSWORD_QUOTA

BEGIN;
CREATE ROLE giga_api_runtime NOLOGIN NOINHERIT;
CREATE ROLE giga_agent_quota_owner NOLOGIN NOINHERIT;
CREATE ROLE giga_agent_quota_finalizer NOLOGIN NOINHERIT;
CREATE ROLE giga_agent_lifecycle_owner NOLOGIN NOINHERIT;
CREATE ROLE giga_agent_lifecycle_finalizer NOLOGIN NOINHERIT;

CREATE ROLE giga_migration LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migration_password';
CREATE ROLE giga_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'api_password';
CREATE ROLE giga_lifecycle LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lifecycle_password';
CREATE ROLE giga_quota LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'quota_password';

-- Existing migrations perform GRANT/REVOKE and transfer protected ownership.
-- Precreate their roles so the migration login needs no CREATEROLE privilege.
GRANT giga_agent_quota_owner, giga_agent_lifecycle_owner, giga_agent_lifecycle_finalizer TO giga_migration WITH ADMIN OPTION;
GRANT giga_api_runtime TO giga_runtime;
GRANT giga_agent_lifecycle_finalizer TO giga_lifecycle;
GRANT giga_agent_quota_finalizer TO giga_quota;

ALTER DATABASE giga OWNER TO giga_migration;
REVOKE ALL ON DATABASE giga FROM PUBLIC;
GRANT CONNECT ON DATABASE giga TO giga_runtime, giga_lifecycle, giga_quota;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO giga_migration, giga_agent_quota_owner, giga_agent_lifecycle_owner;
GRANT USAGE ON SCHEMA public TO giga_api_runtime, giga_agent_lifecycle_finalizer, giga_agent_quota_finalizer;

-- Restrict future-table and sequence default privileges (P2):
-- Replace fail-open default grants with a controlled least-privilege policy.
-- Future tables created by giga_migration do not grant CRUD to giga_api_runtime
-- unless explicitly authorized. Sequences receive USAGE, SELECT only (no UPDATE / setval).
ALTER DEFAULT PRIVILEGES FOR ROLE giga_migration IN SCHEMA public REVOKE ALL ON TABLES FROM giga_api_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE giga_migration IN SCHEMA public REVOKE ALL ON SEQUENCES FROM giga_api_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE giga_migration IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO giga_api_runtime;
COMMIT;
SQL

echo 'Giga PostgreSQL roles initialized; migrations and production startup validation remain required.'

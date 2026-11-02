-- Run against ONLY the local Compose database (or its disposable restore) as
-- giga_admin, after all migrations and startup hardening have completed:
-- docker compose exec -T postgres psql -U giga_admin -d giga -v ON_ERROR_STOP=1 < infra/docker/postgres/roles-check.sql
-- No application rows are changed; denied writes use WHERE FALSE.
\set ON_ERROR_STOP on
BEGIN;
DO $check$
DECLARE
  login TEXT;
  owner_role TEXT;
  protected_table TEXT;
  expected_role TEXT;
  function_name TEXT;
  function_signature TEXT;
  allowed_role TEXT;
BEGIN
  IF current_user <> 'giga_admin' OR NOT (
    current_database() = 'giga' OR current_database() ~ '^giga_restore_test_[0-9a-f]{32}$'
  ) THEN
    RAISE EXCEPTION 'Role verification is limited to the local Giga Compose database and disposable restores';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = 16) THEN
    RAISE EXCEPTION 'Migration 016 is not applied';
  END IF;
  FOREACH login IN ARRAY ARRAY['giga_migration', 'giga_runtime', 'giga_lifecycle', 'giga_quota'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login AND rolcanlogin
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
      RAISE EXCEPTION 'Login % has missing or excessive privileges', login;
    END IF;
  END LOOP;
  FOREACH owner_role IN ARRAY ARRAY['giga_api_runtime', 'giga_agent_quota_owner', 'giga_agent_quota_finalizer',
      'giga_agent_lifecycle_owner', 'giga_agent_lifecycle_finalizer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role AND NOT rolcanlogin AND NOT rolsuper) THEN
      RAISE EXCEPTION 'Protected role % must be non-login and non-superuser', owner_role;
    END IF;
  END LOOP;
  FOR login, expected_role IN VALUES ('giga_runtime', 'giga_api_runtime'),
      ('giga_lifecycle', 'giga_agent_lifecycle_finalizer'), ('giga_quota', 'giga_agent_quota_finalizer') LOOP
    FOREACH owner_role IN ARRAY ARRAY['giga_api_runtime', 'giga_agent_quota_owner', 'giga_agent_quota_finalizer',
        'giga_agent_lifecycle_owner', 'giga_agent_lifecycle_finalizer'] LOOP
      IF pg_has_role(login, owner_role, 'MEMBER') IS DISTINCT FROM (owner_role = expected_role) THEN
        RAISE EXCEPTION 'Unexpected membership: % -> %', login, owner_role;
      END IF;
    END LOOP;
    IF has_schema_privilege(login, 'public', 'CREATE') OR has_database_privilege(login, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'Application/finalizer login % must not create schema objects', login;
    END IF;
  END LOOP;
  FOR protected_table, owner_role IN VALUES
      ('agent_execution_reservations', 'giga_agent_quota_owner'),
      ('agent_execution_usage_events', 'giga_agent_quota_owner'),
      ('agent_sandbox_sessions', 'giga_agent_lifecycle_owner'),
      ('agent_sandbox_lifecycle_operations', 'giga_agent_lifecycle_owner'),
      ('agent_sandbox_attempt_fences', 'giga_agent_lifecycle_owner') LOOP
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.' || protected_table)) IS DISTINCT FROM owner_role THEN
      RAISE EXCEPTION 'Unexpected owner of protected table %', protected_table;
    END IF;
    IF has_table_privilege('giga_runtime', 'public.' || protected_table, 'DELETE,TRUNCATE,TRIGGER') THEN
      RAISE EXCEPTION 'Runtime has excessive privileges on %', protected_table;
    END IF;
  END LOOP;
  IF has_table_privilege('giga_runtime', 'public.schema_migrations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') THEN
    RAISE EXCEPTION 'Runtime must not access migration history';
  END IF;
  FOR function_name, function_signature, owner_role, allowed_role IN VALUES
    ('settle_agent_sandbox_allocation', 'uuid,uuid,uuid,integer,uuid,character varying,character varying,character varying', 'giga_agent_lifecycle_owner', 'giga_lifecycle'),
    ('claim_agent_sandbox_cleanup', 'uuid,character varying,character varying,integer', 'giga_agent_lifecycle_owner', 'giga_lifecycle'),
    ('finalize_agent_sandbox_destruction', 'uuid,character varying,character varying', 'giga_agent_lifecycle_owner', 'giga_lifecycle'),
    ('finalize_agent_execution_reconciliation', 'uuid,character varying,character,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean', 'giga_agent_quota_owner', 'giga_quota') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.' || function_name || '(' || function_signature || ')')
        AND pg_get_userbyid(proowner) = owner_role AND prosecdef) THEN
      RAISE EXCEPTION 'Controlled function % has incorrect owner/security mode', function_name;
    END IF;
    IF has_function_privilege('giga_runtime', 'public.' || function_name || '(' || function_signature || ')', 'EXECUTE')
        OR NOT has_function_privilege(allowed_role, 'public.' || function_name || '(' || function_signature || ')', 'EXECUTE') THEN
      RAISE EXCEPTION 'Controlled function % has incorrect execute privileges', function_name;
    END IF;
  END LOOP;
END;
$check$;

SET LOCAL ROLE giga_runtime;
DO $deny$
BEGIN
  BEGIN UPDATE public.schema_migrations SET version = version WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly wrote migration history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.agent_execution_reservations SET reconciliation_event_key = reconciliation_event_key WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly wrote quota finalization marker';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.agent_execution_usage_events WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly deleted quota events';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.agent_sandbox_sessions SET provider_session_id = provider_session_id WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly wrote provider resource identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.agent_sandbox_sessions SET destroyed_at = destroyed_at WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly wrote provider destruction outcome';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE public.agent_sandbox_lifecycle_operations SET provider_resource_id = provider_resource_id WHERE FALSE;
    RAISE EXCEPTION 'Runtime unexpectedly wrote lifecycle operation provider identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.finalize_agent_sandbox_destruction(NULL::uuid, NULL::varchar, NULL::varchar);
    RAISE EXCEPTION 'Runtime unexpectedly executed lifecycle finalization';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.finalize_agent_execution_reconciliation(NULL::uuid, NULL::varchar, NULL::char,
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, FALSE);
    RAISE EXCEPTION 'Runtime unexpectedly executed quota finalization';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$deny$;

SET LOCAL ROLE giga_lifecycle;
DO $deny$
BEGIN
  BEGIN UPDATE public.agent_sandbox_sessions SET destroyed_at = destroyed_at WHERE FALSE;
    RAISE EXCEPTION 'Lifecycle finalizer unexpectedly wrote protected table directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.agent_sandbox_lifecycle_operations WHERE FALSE;
    RAISE EXCEPTION 'Lifecycle finalizer unexpectedly deleted lifecycle history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$deny$;

SET LOCAL ROLE giga_quota;
DO $deny$
BEGIN
  BEGIN UPDATE public.agent_execution_reservations SET reconciliation_event_key = reconciliation_event_key WHERE FALSE;
    RAISE EXCEPTION 'Quota finalizer unexpectedly wrote marker directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM public.agent_execution_usage_events WHERE FALSE;
    RAISE EXCEPTION 'Quota finalizer unexpectedly deleted quota history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$deny$;
ROLLBACK;
\echo 'PASS: PostgreSQL role attributes, membership, ownership, controlled functions and denied writes'

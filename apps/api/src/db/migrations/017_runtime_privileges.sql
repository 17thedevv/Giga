-- Repair ACLs installed by migration 015 on both fresh and existing databases.
-- Keep the protected quota and lifecycle table grants from 015/016 intact.
DO $runtime_acl$
DECLARE
    target_schema TEXT := current_schema();
    migration_login NAME := current_user;
    table_name TEXT;
BEGIN
    EXECUTE format('REVOKE ALL ON TABLE %I.schema_migrations FROM giga_api_runtime', target_schema);
    EXECUTE format('GRANT SELECT ON TABLE %I.schema_migrations TO giga_api_runtime', target_schema);

    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM giga_api_runtime', migration_login, target_schema);

    FOREACH table_name IN ARRAY ARRAY[
        'users',
        'sessions',
        'conversations',
        'messages',
        'user_preferences',
        'skill_definitions',
        'skill_versions',
        'skill_installations',
        'chat_generations',
        'chat_operation_keys',
        'chat_turn_selections',
        'user_provider_credentials',
        'chat_credential_preferences',
        'agent_workspaces',
        'agent_runs',
        'agent_run_events',
        'agent_run_steps',
        'agent_messages'
    ] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO giga_api_runtime', target_schema, table_name);
    END LOOP;

    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM giga_api_runtime', target_schema);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO giga_api_runtime', target_schema);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM giga_api_runtime', migration_login, target_schema);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO giga_api_runtime', migration_login, target_schema);
END;
$runtime_acl$;

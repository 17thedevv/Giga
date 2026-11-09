import type pg from 'pg';
import { RUNTIME_CRUD_TABLES } from './migrate.js';

export async function findMissingRuntimeTablePrivilege(db: Pick<pg.PoolClient, 'query'>) {
  const result = await db.query<{ table_name: string; privilege: string }>(
    `SELECT t.table_name, p.privilege
     FROM unnest($1::text[]) AS t(table_name)
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)
     WHERE has_table_privilege(current_user, to_regclass(format('public.%I', t.table_name)), p.privilege)
           IS DISTINCT FROM TRUE
     LIMIT 1`,
    [RUNTIME_CRUD_TABLES],
  );
  return result.rows[0];
}

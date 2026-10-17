import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0040 (ADR 0017 slice S4): the secrets table and the sealed values. Runs on PGlite and,
 * with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const TAG = '0040_secrets_store';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const DOWN = readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8');

describe('migration 0040 files', () => {
  it('is strictly ordered, has a snapshot chained to the previous one and a down script', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at]!.idx).toBe(34);
    expect(journal.entries[at]!.when).toBe(1_792_700_000_009);
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    expect(journal.entries[at - 1]!.tag).toBe('0039_agent_version_awp');
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0040').prevId).toBe(read('0039').id);
    expect(Object.keys(read('0040').tables)).toEqual(
      expect.arrayContaining(['public.secrets', 'public.secret_versions']),
    );
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });
});

describe.each(sqlTargets)('migration 0040 (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const team = randomUUID();
  const user = randomUUID();

  const insert = (
    over: Partial<Record<string, string | boolean | null>> = {},
    id: string = randomUUID(),
  ) => {
    const row = {
      tenant_id: root,
      scope: 'tenant',
      scope_id: root,
      name: `n-${id.slice(0, 8)}`,
      ...over,
    } as Record<string, string | boolean | null>;
    const cols = Object.keys(row);
    return c.query(
      `insert into secrets (id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
      [id, ...cols.map((k) => row[k])],
    );
  };

  beforeAll(async () => {
    c = await open();
    await c.migrate(MIGRATIONS_FOLDER);
  }, 120_000);
  afterAll(async () => {
    await c.close();
  });

  it('keeps the name, scope, backend and ownership of a secret well formed', async () => {
    expect(await failure(insert({ name: 'Upper' }))).toMatch(/secrets_name_check/);
    expect(await failure(insert({ name: '-x' }))).toMatch(/secrets_name_check/);
    expect(await failure(insert({ name: 'a'.repeat(129) }))).toMatch(/secrets_name_check/);
    expect(await failure(insert({ scope: 'platform' }))).toMatch(/secrets_scope_check/);
    expect(await failure(insert({ usage: 'always' }))).toMatch(/secrets_usage_check/);
    expect(await failure(insert({ backend: 'vault' }))).toMatch(/secrets_backend_check/);
    // a tenant secret is owned by its own node
    expect(await failure(insert({ scope_id: randomUUID() }))).toMatch(/secrets_tenant_scope_check/);
    // only an env pointer has a pointer
    expect(await failure(insert({ backend: 'env' }))).toMatch(/secrets_pointer_check/);
    expect(await failure(insert({ pointer: 'x' }))).toMatch(/secrets_pointer_check/);
    await insert({ backend: 'env', pointer: 'legacy-name' });
    // an unknown owner node is refused
    expect(
      await failure(insert({ tenant_id: randomUUID(), scope: 'team', scope_id: randomUUID() })),
    ).toMatch(/secrets_tenant_id_tenants_id_fk/);
  });

  it('allows inheritance on tenant secrets only', async () => {
    await insert({ inherit: true, allow_override: false });
    expect(await failure(insert({ scope: 'team', scope_id: team, inherit: true }))).toMatch(
      /secrets_inherit_check/,
    );
    expect(
      await failure(insert({ scope: 'personal', scope_id: user, allow_override: true })),
    ).toMatch(/secrets_inherit_check/);
    await insert({ scope: 'team', scope_id: team });
    await insert({ scope: 'personal', scope_id: user });
  });

  it('has one secret per node, scope, owner and name', async () => {
    await insert({ name: 'dup' });
    expect(await failure(insert({ name: 'dup' }))).toMatch(/secrets_identity_uq/);
    // the same name in another scope or for another owner is another secret
    await insert({ name: 'dup', scope: 'team', scope_id: team });
    await insert({ name: 'dup', scope: 'team', scope_id: randomUUID() });
  });

  it('keeps the identity of a secret immutable (it is the input of the AAD)', async () => {
    const id = randomUUID();
    await insert({ name: 'fixed' }, id);
    for (const [col, val] of [
      ['name', 'other'],
      ['scope', 'team'],
      ['scope_id', randomUUID()],
      ['backend', 'env'],
    ] as const)
      expect(
        await failure(c.query(`update secrets set ${col} = $2 where id = $1`, [id, val])),
      ).toMatch(/immutable|check|pointer/);
    expect(
      await failure(c.query(`update secrets set id = $2 where id = $1`, [id, randomUUID()])),
    ).toMatch(/immutable|foreign key/);
    // the policy columns are immutable as well
    for (const [col, val] of [
      ['usage', 'production'],
      ['inherit', 'true'],
      ['allow_override', 'true'],
      ['allowed_destinations', '["x.example.org"]'],
    ] as const)
      expect(
        await failure(c.query(`update secrets set ${col} = $2 where id = $1`, [id, val])),
      ).toMatch(/immutable|check/);
    await c.query(`update secrets set description = 'ok', expires_at = now() where id = $1`, [id]);
  });

  it('keeps the pointer of an env-backed secret immutable', async () => {
    const id = randomUUID();
    await insert({ name: 'ptr-fixed', backend: 'env', pointer: 'legacy-name' }, id);
    expect(
      await failure(c.query(`update secrets set pointer = 'other-name' where id = $1`, [id])),
    ).toMatch(/immutable/);
  });

  it('deletes the sealed values with their secret', async () => {
    const id = randomUUID();
    await insert({ name: 'sealed' }, id);
    await c.query(
      `insert into secret_versions (secret_id, version, tenant_id, ciphertext, dek_version, aad_digest)
       values ($1, 1, $2, 'oaxe1.a.b.c', 1, 'd')`,
      [id, root],
    );
    expect(
      await failure(
        c.query(
          `insert into secret_versions (secret_id, version, tenant_id, ciphertext, dek_version, aad_digest)
           values ($1, 1, $2, 'x', 1, 'd')`,
          [id, root],
        ),
      ),
    ).toMatch(/secret_versions_secret_id_version_pk/);
    await c.query(`delete from secrets where id = $1`, [id]);
    expect(
      (await c.query(`select 1 from secret_versions where secret_id = $1`, [id])).rows,
    ).toHaveLength(0);
  });

  it('is reverted by the down script', async () => {
    await c.script(DOWN);
    const tables = (
      await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_name in ('secrets', 'secret_versions')`,
      )
    ).rows;
    expect(tables).toEqual([]);
    const fn = await c.query(
      `select 1 from pg_proc where proname = 'oax_secret_identity_immutable'`,
    );
    expect(fn.rows).toHaveLength(0);
  });
});

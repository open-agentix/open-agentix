import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';

const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
  entries: { tag: string }[];
};
const TAG = '0017_approvals_tenant_status_idx';

async function applyMigration(db: PGlite, tag: string) {
  const sql = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) await db.exec(statement);
}

const indexes = async (db: PGlite) =>
  (
    await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'approvals'`,
    )
  ).rows.map((r) => r.indexname);

describe(`migration ${TAG}`, () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    for (const { tag } of journal.entries.filter((e) => e.tag < TAG)) await applyMigration(db, tag);
  });
  afterAll(async () => db.close());

  it('is in the journal after 0016 and adds the index', async () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0016_agent_disable') + 1);
    expect(await indexes(db)).not.toContain('approvals_tenant_status_idx');
    await applyMigration(db, TAG);
    expect(await indexes(db)).toContain('approvals_tenant_status_idx');
  });

  it('is idempotent and reverted by the down script', async () => {
    await applyMigration(db, TAG);
    await db.exec(readFileSync(`${MIGRATIONS_FOLDER}/down/${TAG}.down.sql`, 'utf8'));
    expect(await indexes(db)).not.toContain('approvals_tenant_status_idx');
    await db.exec(readFileSync(`${MIGRATIONS_FOLDER}/down/${TAG}.down.sql`, 'utf8'));
  });
});

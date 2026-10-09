import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';

const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
  entries: { tag: string }[];
};
const TAG = '0016_agent_disable';

async function applyMigration(db: PGlite, tag: string) {
  const sql = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) await db.exec(statement);
}

describe(`migration ${TAG}`, () => {
  let db: PGlite;
  const existing = randomUUID();

  beforeAll(async () => {
    db = new PGlite();
    for (const { tag } of journal.entries.filter((e) => e.tag < TAG)) await applyMigration(db, tag);
    await db.query(
      `insert into agents (id, tenant_id, name, draft_source) values ($1, $2, 'old', 'x')`,
      [existing, DEFAULT_TENANT_ID],
    );
    await applyMigration(db, TAG);
  });
  afterAll(async () => db.close());

  it('is in the journal and keeps existing agents enabled', async () => {
    expect(journal.entries.map((e) => e.tag)).toContain(TAG);
    const { rows } = await db.query<{
      disabled_at: Date | null;
      disabled_by: string | null;
      disabled_reason: string | null;
    }>(`select disabled_at, disabled_by, disabled_reason from agents where id = $1`, [existing]);
    expect(rows[0]).toEqual({ disabled_at: null, disabled_by: null, disabled_reason: null });
  });

  it('limits the reason to 500 characters', async () => {
    const set = (reason: string) =>
      db.query(`update agents set disabled_at = now(), disabled_reason = $2 where id = $1`, [
        existing,
        reason,
      ]);
    await expect(set('x'.repeat(501))).rejects.toThrow(/agents_disabled_reason_len/);
    await set('x'.repeat(500));
  });

  it('is reverted by the down script', async () => {
    await db.exec(readFileSync(`${MIGRATIONS_FOLDER}/down/${TAG}.down.sql`, 'utf8'));
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'agents'`,
    );
    expect(rows.map((r) => r.column_name)).not.toContain('disabled_at');
    expect(rows.map((r) => r.column_name)).not.toContain('disabled_reason');
  });
});

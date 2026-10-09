import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';

const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
  entries: { tag: string }[];
};
const TAG = '0015_agent_summary_fields';

async function applyMigration(db: PGlite, tag: string) {
  const sql = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) await db.exec(statement);
}

const draft = (name: string, labelsBlock: string) =>
  `---\nname: ${name}\nversion: 1.0.0\nowner: team\n${labelsBlock}\nagents:\n  - id: a\n---\n`;

describe(`migration ${TAG}`, () => {
  let db: PGlite;
  const ids = { published: randomUUID(), draftOnly: randomUUID(), noLabel: randomUUID() };

  beforeAll(async () => {
    db = new PGlite();
    for (const { tag } of journal.entries.filter((e) => e.tag < TAG)) await applyMigration(db, tag);
    const insertAgent = (id: string, name: string, source: string, versionId: string | null) =>
      db.query(
        `insert into agents (id, tenant_id, name, draft_source, latest_version_id) values ($1, $2, $3, $4, $5)`,
        [id, DEFAULT_TENANT_ID, name, source, versionId],
      );
    const versionId = randomUUID();
    await insertAgent(
      ids.published,
      'published',
      draft('published', 'labels:\n  useCase: ignored'),
      null,
    );
    await db.query(
      `insert into agent_versions (id, agent_id, version, digest, source, definition) values ($1, $2, '1.0.0', 'd', 's', $3)`,
      [versionId, ids.published, JSON.stringify({ labels: { useCase: 'support/billing' } })],
    );
    await db.query(`update agents set latest_version_id = $1 where id = $2`, [
      versionId,
      ids.published,
    ]);
    await insertAgent(
      ids.draftOnly,
      'draft-only',
      draft('draft-only', 'labels:\n  team: x\n  useCase: "operations"  # ops'),
      null,
    );
    await insertAgent(ids.noLabel, 'no-label', draft('no-label', ''), null);
    await applyMigration(db, TAG);
  });
  afterAll(async () => db.close());

  const useCaseOf = async (id: string) =>
    (await db.query<{ use_case: string | null }>(`select use_case from agents where id = $1`, [id]))
      .rows[0]!.use_case;

  it('backfills the use case from the latest published version', async () => {
    expect(await useCaseOf(ids.published)).toBe('support/billing');
  });

  it('backfills never published agents from the draft labels, best effort', async () => {
    expect(await useCaseOf(ids.draftOnly)).toBe('operations');
    expect(await useCaseOf(ids.noLabel)).toBeNull();
  });

  it('creates the list indexes', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'agents'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('agents_tenant_created_idx');
    expect(names).toContain('agents_tenant_use_case_idx');
  });

  it('is reverted by the down script', async () => {
    const down = readFileSync(`${MIGRATIONS_FOLDER}/down/${TAG}.down.sql`, 'utf8');
    await db.exec(down);
    const { rows } = await db.query(
      `select 1 from information_schema.columns where table_name = 'agents' and column_name = 'use_case'`,
    );
    expect(rows).toHaveLength(0);
  });
});

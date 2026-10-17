import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentDefinition } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/client.js';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { convertLegacyVersions } from '../src/services/legacy-awp.js';
import { example } from './fixtures.js';
import { failure, sqlTargets, type Sql } from './db-targets.js';

/**
 * Migration 0038 (AWP-3b): the table for the stored effective AWP manifests, the one-time conversion
 * that runs after it (up, re-run, rollback path), and what it must never touch: source, digest and
 * definition of a published version. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on PostgreSQL.
 */
const TAG = '0038_agent_version_awp';
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};

describe('migration 0038 files', () => {
  it('is strictly newer than 0037, chains its snapshot, keeps the index contiguous, has a down path', () => {
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(journal.entries[at - 1]!.tag).toBe('0037_stored_grant_chain');
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
    expect(new Set(whens).size).toBe(whens.length);
    const read = (n: string) =>
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, `meta/${n}_snapshot.json`), 'utf8'));
    expect(read('0038').prevId).toBe(read('0037').id);
    expect(read('0038').tables['public.agent_version_awp'].columns.version_id.primaryKey).toBe(
      true,
    );
    expect(existsSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`))).toBe(true);
  });

  it('does not touch agent_versions', () => {
    expect(readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).not.toMatch(
      /(alter|update|delete|insert|truncate)[^;]*"?agent_versions"?\s/i,
    );
  });
});

describe.each(sqlTargets)('migration 0038 on existing data (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let dir: string;
  let c: Sql;
  const root = DEFAULT_TENANT_ID;
  const team = randomUUID();
  const security = randomUUID();
  const good = { agent: randomUUID(), version: randomUUID(), second: randomUUID() };
  const bad = { agent: randomUUID(), version: randomUUID() };
  const noTeam = { agent: randomUUID(), version: randomUUID() };
  const broken = { agent: randomUUID(), version: randomUUID() };
  const fingerprint = async () =>
    (
      await c.query<{ h: string }>(
        `select md5(string_agg(id::text || version || digest || source || definition::text, '|' order by id)) as h from agent_versions`,
      )
    ).rows[0]!.h;
  const awp = async (versionId: string) =>
    (
      await c.query<{
        status: string;
        manifest: unknown;
        manifest_digest: string | null;
        findings: { code: string }[];
        agent_id: string;
        converter: string;
      }>(`select * from agent_version_awp where version_id = $1`, [versionId])
    ).rows[0];
  const addAgent = (id: string, name: string, teamId: string | null) =>
    c.query(
      `insert into agents (id, tenant_id, name, team_id, draft_source) values ($1, $2, $3, $4, 'd')`,
      [id, root, name, teamId],
    );
  const addVersion = (id: string, agentId: string, version: string, source: string, def: unknown) =>
    c.query(
      `insert into agent_versions (id, agent_id, version, digest, source, definition) values ($1, $2, $3, 'sha', $4, $5::jsonb)`,
      [id, agentId, version, source, JSON.stringify(def)],
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oax-mig-'));
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < TAG);
    writeFileSync(journalPath, JSON.stringify(j));
    c = await open();
    await c.migrate(dir);
    await c.query(
      `insert into teams (id, tenant_id, slug, name) values ($1, $2, 'team-docs', 'Docs')`,
      [team, root],
    );
    await c.query(
      `insert into teams (id, tenant_id, slug, name) values ($1, $2, 'team-security', 'Security')`,
      [security, root],
    );
    const releaseNotes = example('awp/release-notes.agents.md');
    await addAgent(good.agent, 'good', team);
    await addVersion(
      good.version,
      good.agent,
      '1.0.0',
      releaseNotes,
      loadAgentDefinition(releaseNotes),
    );
    await addVersion(
      good.second,
      good.agent,
      '1.1.0',
      releaseNotes,
      loadAgentDefinition(releaseNotes),
    );
    const updater = example('ticket-updater.agents.md');
    await addAgent(bad.agent, 'bad', security);
    await addVersion(bad.version, bad.agent, '1.0.0', updater, loadAgentDefinition(updater));
    await addAgent(noTeam.agent, 'no-team', null);
    await addVersion(
      noTeam.version,
      noTeam.agent,
      '1.0.0',
      releaseNotes,
      loadAgentDefinition(releaseNotes),
    );
    await addAgent(broken.agent, 'broken', team);
    await addVersion(broken.version, broken.agent, '1.0.0', 'x', { owner: 'team-docs', agents: 7 });
  });
  afterAll(async () => {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the table empty, converts every version once and leaves published content alone', async () => {
    const before = await fingerprint();
    await c.migrate(MIGRATIONS_FOLDER);
    expect((await c.query(`select 1 from agent_version_awp`)).rows).toHaveLength(0);
    const r = await convertLegacyVersions(c.db);
    expect(r).toEqual({ agents: 4, converted: 2, unconvertible: 3 });
    expect(await fingerprint()).toBe(before);
    expect((await awp(good.version))!.status).toBe('converted');
    expect((await awp(good.version))!.manifest_digest).toMatch(/^sha256:/);
    expect((await awp(good.second))!.status).toBe('converted');
    const refused = (await awp(bad.version))!;
    expect(refused.status).toBe('legacy-unconvertible');
    expect(refused.manifest).toBeNull();
    expect(refused.findings.map((f) => f.code)).toContain('critical_extension');
    expect((await awp(noTeam.version))!.findings.map((f) => f.code)).toEqual([
      'owner_team_required',
    ]);
    expect((await awp(broken.version))!.findings[0]!.code).toBe('conversion_error');
  });

  it('is idempotent: a second run converts nothing and changes no row', async () => {
    const rows = JSON.stringify(
      (await c.query(`select * from agent_version_awp order by version_id`)).rows,
    );
    expect(await convertLegacyVersions(c.db)).toEqual({
      agents: 0,
      converted: 0,
      unconvertible: 0,
    });
    expect(
      JSON.stringify((await c.query(`select * from agent_version_awp order by version_id`)).rows),
    ).toBe(rows);
  });

  it('converts a version published later and leaves the earlier rows alone', async () => {
    const source = example('awp/release-notes.agents.md');
    const later = randomUUID();
    await addVersion(later, good.agent, '1.2.0', source, loadAgentDefinition(source));
    const before = JSON.stringify(await awp(good.version));
    const insert = (status: string, manifest: string, digest: string) =>
      c.query(
        `insert into agent_version_awp (version_id, agent_id, status, manifest, manifest_digest, converter) values ($1, $2, $3, ${manifest}, ${digest}, 'x')`,
        [later, good.agent, status],
      );
    // A "converted" row without a manifest, an unconvertible one that carries one, an unknown status.
    expect(await failure(insert('converted', 'null', 'null'))).toContain('agent_version_awp_shape');
    expect(await failure(insert('legacy-unconvertible', `'{}'::jsonb`, `'d'`))).toContain(
      'agent_version_awp_shape',
    );
    expect(await failure(insert('other', 'null', 'null'))).toContain('violates check constraint');
    expect(await convertLegacyVersions(c.db)).toEqual({
      agents: 1,
      converted: 1,
      unconvertible: 0,
    });
    expect(JSON.stringify(await awp(good.version))).toBe(before);
    expect((await awp(later))!.status).toBe('converted');
  });

  it('refuses a row that violates the shape, an update and a delete', async () => {
    const insertBad = await failure(
      c.query(
        `insert into agent_version_awp (version_id, agent_id, status, converter) select id, agent_id, 'legacy-unconvertible', 'x' from agent_versions where id = $1`,
        [bad.version],
      ),
    );
    expect(insertBad).toContain('duplicate key');
    expect(
      await failure(
        c.query(`update agent_version_awp set status = 'converted' where version_id = $1`, [
          bad.version,
        ]),
      ),
    ).toContain('append-only');
    expect(
      await failure(c.query(`delete from agent_version_awp where version_id = $1`, [good.version])),
    ).toContain('append-only');
    expect(
      await failure(
        c.query(`update agent_versions set source = 'y' where id = $1`, [good.version]),
      ),
    ).toContain('append-only');
  });

  it('rolls back with the down script (only the new table goes) and applies again', async () => {
    const before = await fingerprint();
    await c.script(readFileSync(join(MIGRATIONS_FOLDER, `down/${TAG}.down.sql`), 'utf8'));
    expect(
      (await c.query<{ t: string | null }>(`select to_regclass('agent_version_awp')::text as t`))
        .rows[0]!.t,
    ).toBeNull();
    expect(await fingerprint()).toBe(before);
    expect((await c.query(`select 1 from agents`)).rows.length).toBe(4);
    // The same SQL again (the journal row is still there, so run the file directly), then convert again.
    const up = readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8');
    for (const statement of up.split('--> statement-breakpoint')) await c.exec(statement);
    expect(await convertLegacyVersions(c.db)).toMatchObject({
      agents: 4,
      converted: 3,
      unconvertible: 3,
    });
    expect(await fingerprint()).toBe(before);
  });
});

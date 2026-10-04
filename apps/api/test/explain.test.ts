import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';

/**
 * Hot queries must be answerable from an index. Tables are tiny in tests, so sequential scans are
 * disabled to ask the planner whether an index path exists at all.
 */
let database: Database;
const ID = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  database = await createDatabase({ url: 'memory://' });
  await database.migrate();
  // Planner statistics of a realistic ledger: on an empty table (estimated from the row width)
  // two indexes can tie and the winner changes whenever a column is added.
  await database.db.execute(sql`
    insert into cost_ledger (tenant_id, run_id, agent_id, team_id, month, cost_micros)
    select '00000000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(),
           gen_random_uuid(), date '2026-09-01' + (i % 12) * 30, 1
    from generate_series(1, 3000) as i`);
  await database.db.execute(sql`analyze cost_ledger`);
  await database.db.execute(sql`set enable_seqscan = off`);
});
afterAll(async () => database.close());

async function plan(q: SQL): Promise<string> {
  const res = (await database.db.execute(sql`explain ${q}`)) as unknown as {
    rows: Record<string, string>[];
  };
  return res.rows.map((r) => Object.values(r)[0]).join('\n');
}

describe('query plans use indexes', () => {
  it.each([
    [
      'runs by agent, newest first',
      sql`select * from runs where agent_id = ${ID} order by created_at desc, id desc limit 51`,
      'runs_agent_created_idx',
    ],
    [
      'runs by status, newest first',
      sql`select * from runs where status = 'running' order by created_at desc, id desc limit 51`,
      'runs_status_created_idx',
    ],
    [
      'runs keyset page',
      sql`select * from runs where (created_at, id) < (now(), ${ID}::uuid) order by created_at desc, id desc limit 51`,
      'runs_created_idx',
    ],
    [
      'queue claim',
      sql`select id from runs where status = 'queued' and available_at <= now() order by available_at, created_at limit 10 for update skip locked`,
      'runs_queue_idx',
    ],
    [
      'expired leases',
      sql`select id from runs where status in ('running', 'awaiting_approval') and lease_until < now()`,
      'runs_lease_idx',
    ],
    [
      'audit by run',
      sql`select * from audit_log where run_id = ${ID} order by seq`,
      'audit_run_seq_idx',
    ],
    [
      'audit by time',
      sql`select * from audit_log where ts >= now() - interval '1 day' order by ts desc, seq desc limit 50`,
      'audit_ts_idx',
    ],
    [
      'events by source',
      sql`select * from events where source_id = ${ID} order by received_at desc, id desc limit 51`,
      'events_source_received_idx',
    ],
    [
      'steps of a run',
      sql`select * from run_steps where run_id = ${ID} and seq > 0 order by seq limit 201`,
      'run_steps_run_id_seq_pk',
    ],
    [
      'costs per team and month',
      sql`select sum(cost_micros) from cost_ledger where team_id = ${ID} and month = '2026-10-01'`,
      'cost_team_month_idx',
    ],
    [
      'pending approvals',
      sql`select * from approvals where status = 'pending' order by requested_at desc, id desc limit 51`,
      'approvals_status_idx',
    ],
  ])('%s', async (_name, query, index) => {
    expect(await plan(query)).toContain(index);
  });
});

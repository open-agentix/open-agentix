import {
  PERMISSIONS,
  effectiveAt,
  hasPermission,
  sameBindings,
  type Principal,
} from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/demo/seed.js';
import { users as usersTable } from '../src/db/schema.js';
import { loadRawGrants } from '../src/services/role-bindings.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 S1 migration equivalence on the demo seed (tenant tree with global, team and agent
 * roles): for every seeded user the tenant role resolver gives exactly what the legacy path gives,
 * and so do the permission checks built on top of it.
 */
let n: TestNode;
beforeAll(async () => {
  n = await testNode({ OAX_DEMO_MODE: 'true' });
}, 300_000);
afterAll(async () => n.close());

describe('demo seed: resolver equals legacy bindings', () => {
  it('for every user, with identical permission checks and no shadow mismatch', async () => {
    const all = await n.ctx.db.select().from(usersTable);
    expect(all.length).toBeGreaterThanOrEqual(DEMO_USERS.length + 1);
    for (const user of all) {
      const legacy = await n.services.identity.principalForUser(user.id);
      const loaded = (await loadRawGrants(n.ctx.db, user))!;
      const fresh = effectiveAt(loaded.raw, loaded.home, {
        now: n.ctx.now(),
        implicitPlatformAdmin: false,
      });
      expect(sameBindings(legacy.bindings, fresh), user.email).toBe(true);
      const viaResolver: Principal = { ...legacy, bindings: fresh };
      for (const p of PERMISSIONS)
        expect(hasPermission(viaResolver, p), `${user.email} ${p}`).toBe(hasPermission(legacy, p));
    }
    const counts = Object.fromEntries(
      (await n.ctx.metrics.roleBindingsShadow.get()).values.map((v) => [v.labels.outcome, v.value]),
    );
    expect(counts.mismatch ?? 0).toBe(0);
    expect(counts.error ?? 0).toBe(0);
    expect(counts.match).toBeGreaterThanOrEqual(all.length);
  });
});

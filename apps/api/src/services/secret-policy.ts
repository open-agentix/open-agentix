import { parseNameGlobs, type Principal } from '@openagentix/core';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import { assertSecrets } from './secret-access.js';
import { blockedGlobsOf, type SecretResolution } from './secret-resolution.js';
import { lockTreeShared } from './tree-lock.js';

/** Narrowing at a lower node: the inherited names a node and its subtree do not see (ADR 0017 13.3). */
export class SecretPolicy {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly resolution: SecretResolution,
  ) {}

  async policy(p: Principal): Promise<{ blockInherited: string[]; effectiveBlocked: string[] }> {
    assertSecrets(p, 'read', 'tenant', null);
    const chain = await this.resolution.chainOf(this.ctx.db, p.tenantId);
    if (!chain) throw notFound('tenant');
    const [own] = chain.nodes;
    return {
      blockInherited: own!.blockInherited as string[],
      effectiveBlocked: [...new Set(chain.nodes.flatMap((n) => n.blockInherited))].sort(),
    };
  }

  /** `settings.secrets.blockInherited` of the acting node: only ever hides names, so it narrows. */
  async setPolicy(p: Principal, input: { blockInherited: string[] }): Promise<void> {
    assertSecrets(p, 'write', 'tenant', null);
    const globs = parseNameGlobs(input.blockInherited);
    if (!globs) throw new HttpError(400, 'validation_failed', 'blockInherited must be name globs');
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [node] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, p.tenantId))
        .for('update');
      if (!node) throw notFound('tenant');
      await lockTreeShared(tx, node.rootId);
      await tx
        .update(tenants)
        .set({
          settings: sql`jsonb_set(${tenants.settings}, '{secrets}', ${JSON.stringify({ blockInherited: globs })}::jsonb, true)`,
        })
        .where(eq(tenants.id, node.id));
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: p.tenantId,
          action: 'secret.policy.changed',
          target: node.id,
          payload: { blockInherited: globs, previous: blockedGlobsOf(node.settings) },
        },
        tx,
      );
    });
  }
}

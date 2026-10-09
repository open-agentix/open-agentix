import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

/** Tenant price overrides must not rewrite platform prices through a name collision. */
let n: TestNode;
let tenantId: string;

beforeAll(async () => {
  n = await testNode({
    OAX_PRICE_TABLE: JSON.stringify([
      { provider: 'openai', model: 'gpt-x', inputPerMTok: 5, outputPerMTok: 15 },
    ]),
  });
  tenantId = (await n.ctx.db.select({ id: tenants.id }).from(tenants))[0]!.id;
  const conn = (name: string, models?: unknown) =>
    n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name,
        kind: 'model',
        config: {
          kind: 'openai',
          apiKeySecret: 'does-not-matter',
          ...(models ? { models } : {}),
        },
      },
    });
  // A tenant connection named like the catalog provider with a price of zero ...
  expect(
    (await conn('openai', [{ id: 'gpt-x', inputPerMTok: 0, outputPerMTok: 0 }])).statusCode,
  ).toBe(201);
  // ... and another connection without prices that falls back to the adapter kind.
  expect((await conn('corp-gpt')).statusCode).toBe(201);
});
afterAll(async () => n.close());

const scope = () => ({ tenantId, teamId: null, agentId: 'a' });

describe('ModelsService.priceFor', () => {
  it('does not let a tenant connection named like a catalog provider zero the platform price', async () => {
    const price = await n.services.models.priceFor(scope(), 'corp-gpt', 'gpt-x');
    expect(price).toMatchObject({ inputPerMTok: 5, outputPerMTok: 15 });
  });

  it('applies the override under the connection name the agent actually uses', async () => {
    const price = await n.services.models.priceFor(scope(), 'openai', 'gpt-x');
    expect(price).toMatchObject({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('does not apply overrides of another tenant', async () => {
    const price = await n.services.models.priceFor(
      { tenantId: '00000000-0000-4000-8000-000000000000', teamId: null, agentId: 'a' },
      'openai',
      'gpt-x',
    );
    expect(price).toMatchObject({ inputPerMTok: 5, outputPerMTok: 15 });
  });
});

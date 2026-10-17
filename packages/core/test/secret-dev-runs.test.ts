import { describe, expect, it } from 'vitest';
import {
  devRunSecretVerdict,
  productionRunSecretVerdict,
  usageAllowsStage,
  type DevRunContext,
  type DevRunSecret,
} from '../src/index.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NODE = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444444';

const secret = (over: Partial<DevRunSecret> = {}): DevRunSecret => ({
  scope: 'tenant',
  scopeId: NODE,
  tenantId: NODE,
  usage: 'any',
  ...over,
});
const ctx = (over: Partial<DevRunContext['policy']> = {}, starter = OWNER): DevRunContext => ({
  agentNodeId: NODE,
  starterUserId: starter,
  policy: {
    allowDraftRuns: 'development-credentials',
    allowPersonalSecretsInDevRuns: true,
    allowProductionSecretsInDraftRuns: false,
    ...over,
  },
});

describe('usageAllowsStage (usage matrix)', () => {
  it.each([
    ['any', 'production', true],
    ['any', 'development', true],
    ['production', 'production', true],
    ['production', 'development', false],
    ['development', 'development', true],
    ['development', 'production', false],
  ] as const)('usage %s in a %s run: %s', (usage, stage, expected) => {
    expect(usageAllowsStage(usage, stage)).toBe(expected);
  });

  it('lets a development run use a production secret only with draft runs "on" and the flag', () => {
    const p = (allowDraftRuns: 'off' | 'development-credentials' | 'on', flag: boolean) => ({
      allowDraftRuns,
      allowProductionSecretsInDraftRuns: flag,
    });
    expect(usageAllowsStage('production', 'development', p('on', true))).toBe(true);
    expect(usageAllowsStage('production', 'development', p('on', false))).toBe(false);
    expect(usageAllowsStage('production', 'development', p('development-credentials', true))).toBe(
      false,
    );
    expect(usageAllowsStage('production', 'development', p('off', true))).toBe(false);
  });
});

describe('devRunSecretVerdict', () => {
  it('issues own-node and team secrets of usage development or any', () => {
    for (const usage of ['development', 'any'] as const) {
      expect(devRunSecretVerdict(secret({ usage }), ctx())).toBeNull();
      expect(devRunSecretVerdict(secret({ scope: 'team', usage }), ctx())).toBeNull();
    }
  });

  it('refuses a production secret unless the policy lets drafts use them', () => {
    expect(devRunSecretVerdict(secret({ usage: 'production' }), ctx())).toBe('secret_not_usable');
    expect(
      devRunSecretVerdict(
        secret({ usage: 'production' }),
        ctx({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true }),
      ),
    ).toBeNull();
  });

  it('refuses everything when draft runs are off', () => {
    expect(devRunSecretVerdict(secret(), ctx({ allowDraftRuns: 'off' }))).toBe(
      'secret_scope_not_usable',
    );
  });

  describe('personal secrets', () => {
    const mine = secret({ scope: 'personal', scopeId: OWNER });
    it('are issued to a run started by their owner', () => {
      expect(devRunSecretVerdict(mine, ctx())).toBeNull();
    });
    it('are never issued to a run started by somebody else', () => {
      expect(devRunSecretVerdict(mine, ctx({}, OTHER))).toBe('secret_scope_not_usable');
    });
    it('are never issued when the run has no starter', () => {
      expect(devRunSecretVerdict(mine, { ...ctx(), starterUserId: null })).toBe(
        'secret_scope_not_usable',
      );
    });
    it('need allowPersonalSecretsInDevRuns', () => {
      expect(devRunSecretVerdict(mine, ctx({ allowPersonalSecretsInDevRuns: false }))).toBe(
        'secret_scope_not_usable',
      );
    });
    it('follow the usage matrix like every other secret', () => {
      expect(devRunSecretVerdict({ ...mine, usage: 'production' }, ctx())).toBe(
        'secret_not_usable',
      );
    });
  });

  describe('secrets of a higher node (foreign)', () => {
    it('are refused unless their owner marked them for development', () => {
      expect(devRunSecretVerdict(secret({ tenantId: ROOT, usage: 'any' }), ctx())).toBe(
        'secret_scope_not_usable',
      );
      expect(devRunSecretVerdict(secret({ tenantId: ROOT, usage: 'production' }), ctx())).toBe(
        'secret_scope_not_usable',
      );
      expect(
        devRunSecretVerdict(secret({ tenantId: ROOT, usage: 'development' }), ctx()),
      ).toBeNull();
    });
    it('are refused even with the production flag (the owner has to opt in)', () => {
      expect(
        devRunSecretVerdict(
          secret({ tenantId: ROOT, usage: 'production' }),
          ctx({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true }),
        ),
      ).toBe('secret_scope_not_usable');
    });
  });
});

describe('productionRunSecretVerdict', () => {
  it('never issues a personal secret to a run of a published version', () => {
    expect(productionRunSecretVerdict({ scope: 'personal', usage: 'any' })).toBe(
      'secret_scope_not_usable',
    );
    expect(productionRunSecretVerdict({ scope: 'personal', usage: 'production' })).toBe(
      'secret_scope_not_usable',
    );
  });
  it('refuses a development secret and issues production and any', () => {
    expect(productionRunSecretVerdict({ scope: 'tenant', usage: 'development' })).toBe(
      'secret_not_usable',
    );
    expect(productionRunSecretVerdict({ scope: 'tenant', usage: 'production' })).toBeNull();
    expect(productionRunSecretVerdict({ scope: 'team', usage: 'any' })).toBeNull();
  });
});

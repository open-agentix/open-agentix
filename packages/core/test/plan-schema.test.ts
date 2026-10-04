import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  PLAN_LIMITS,
  checkPlanStructure,
  loadPlan,
  parseCapability,
  parsePlan,
  planDigest,
  ValidationError,
} from '../src/index.js';
import { cleanPlan, plan, step } from './plan-fixtures.js';

describe('parseCapability', () => {
  it.each([
    ['model', { kind: 'model' }],
    ['jira:read', { kind: 'profile', server: 'jira', profile: 'read' }],
    ['crm/get_customer', { kind: 'tool', server: 'crm', tool: 'get_customer', wildcard: false }],
    ['crm/get_*', { kind: 'tool', server: 'crm', tool: 'get_*', wildcard: true }],
    ['crm/*', { kind: 'tool', server: 'crm', tool: '*', wildcard: true }],
  ])('accepts %s', (text, expected) => {
    expect(parseCapability(text)).toEqual(expected);
  });

  it.each([
    '',
    'Jira:read',
    'jira:',
    ':read',
    'jira/',
    'jira:read:x',
    'jira/a/b',
    'jira read',
    'jira/a b',
    'x'.repeat(200),
  ])('rejects %j', (text) => {
    expect(parseCapability(text)).toBeNull();
  });
});

describe('parsePlan', () => {
  it('parses YAML and JSON into the same plan with the same digest', () => {
    const p = cleanPlan();
    const fromYaml = parsePlan(stringify(p));
    const fromJson = parsePlan(JSON.stringify(p));
    expect(fromYaml.errors).toEqual([]);
    expect(fromYaml.plan).toEqual(p);
    expect(planDigest(fromJson.plan!)).toBe(planDigest(fromYaml.plan!));
    expect(planDigest(p)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('applies defaults (approval none, no capabilities)', () => {
    const r = parsePlan(
      JSON.stringify({ ...plan([]), steps: [{ id: 'a', purpose: 'p', access: 'read-only' }] }),
    );
    expect(r.plan?.steps[0]).toMatchObject({ approval: 'none', capabilities: [] });
  });

  it('digest changes when anything changes', () => {
    const a = cleanPlan();
    const b = cleanPlan();
    b.steps[0]!.purpose = 'other';
    expect(planDigest(a)).not.toBe(planDigest(b));
  });

  it.each([
    ['not an object', '[]'],
    ['unknown key', JSON.stringify({ ...cleanPlan(), extra: 1 })],
    [
      'unknown step key',
      JSON.stringify({
        ...plan([step({ id: 'a' })]),
        steps: [{ ...step({ id: 'a' }), secret: 'x' }],
      }),
    ],
    ['bad kind', JSON.stringify({ ...cleanPlan(), kind: 'Agent' })],
    ['bad apiVersion', JSON.stringify({ ...cleanPlan(), apiVersion: 'x' })],
    ['no steps', JSON.stringify({ ...cleanPlan(), steps: [] })],
    [
      '21 steps',
      JSON.stringify(
        plan(Array.from({ length: 21 }, (_, i) => step({ id: `s${'a'.repeat(i + 1)}` }))),
      ),
    ],
    ['bad capability', JSON.stringify(plan([step({ id: 'a', capabilities: ['Jira:read'] })]))],
    ['missing access', JSON.stringify({ ...plan([]), steps: [{ id: 'a', purpose: 'p' }] })],
    [
      'long description',
      JSON.stringify({ ...cleanPlan(), description: 'x'.repeat(PLAN_LIMITS.maxDescription + 1) }),
    ],
    [
      'long purpose',
      JSON.stringify(plan([step({ id: 'a', purpose: 'x'.repeat(PLAN_LIMITS.maxPurpose + 1) })])),
    ],
    ['invalid yaml', 'a: [unclosed'],
    ['duplicate yaml keys', 'name: a\nname: b'],
    ['two documents', '---\na: 1\n---\nb: 2\n'],
  ])('rejects: %s', (_name, source) => {
    const r = parsePlan(source);
    expect(r.plan).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects oversized sources before parsing', () => {
    const r = parsePlan(' '.repeat(PLAN_LIMITS.maxSourceBytes + 1));
    expect(r.errors[0]?.message).toMatch(/larger than/);
  });

  it('survives an alias bomb', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 12; i++) {
      const prev = String.fromCharCode(97 + i);
      lines.push(
        `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`,
      );
    }
    const r = parsePlan(lines.join('\n'));
    expect(r.plan).toBeNull();
  });

  it('structure: SemVer, duplicate ids and capabilities, undefined schema names, duplicate sources', () => {
    const p = plan(
      [
        step({
          id: 'a',
          capabilities: ['jira:read', 'jira:read'],
          input: { from: ['event', 'event'], schema: 'Nope' },
          output: { schema: 'Nope2' },
        }),
        step({ id: 'a' }),
      ],
      { version: 'one' },
    );
    const paths = checkPlanStructure(p).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'version',
        'steps.1.id',
        'steps.0.capabilities.1',
        'steps.0.input.schema',
        'steps.0.output.schema',
        'steps.0.input.from',
      ]),
    );
  });

  it('structure: schema subset violations are refused', () => {
    const p = plan([step({ id: 'a' })], { schemas: { Bad: { type: 'object', $defs: {} } } });
    expect(checkPlanStructure(p).some((i) => i.path.startsWith('schemas.Bad'))).toBe(true);
  });

  it('loadPlan throws a ValidationError', () => {
    expect(() => loadPlan('{}')).toThrow(ValidationError);
    expect(loadPlan(JSON.stringify(cleanPlan())).name).toBe('ticket-analysis');
  });
});

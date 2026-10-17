import { describe, expect, it } from 'vitest';
import {
  evaluateWhen,
  parseWhen,
  validateManifestSource,
  WhenError,
  type ManifestFinding,
  type WhenNode,
  type WhenPath,
} from '../src/index.js';
import { AWP_SCHEMA } from '../src/awp/generated/awp-schema.js';
import { toAwpWhen } from '../src/awp/when-awp.js';
import { PINNED_AWP_FEATURES } from '../src/awp/types.js';
import { exportOf, probe } from './awp-fixtures.js';
import { pinErrors } from './awp-pin.js';

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Parser, AEP-0001 dialect
// ---------------------------------------------------------------------------------------------

const awp = (s: string): WhenNode => parseWhen(s, 'awp');
const failure = (s: string): WhenError => {
  try {
    awp(s);
  } catch (e) {
    return e as WhenError;
  }
  throw new Error(`expected "${s}" to be rejected`);
};

describe('AEP-0001 grammar (dialect "awp")', () => {
  it.each([
    'steps.analysis.outputs.severity in ["high", "critical"]',
    'inputs.ticket == "T-1" && !exists(steps.a.outputs.x.y[0])',
    'event.data == null || execution.environment == "prod"',
    'inputs.n >= 1.5e3',
    '("a\\u0041\\n" == inputs.s)',
  ])('accepts %s', (s) => {
    expect(() => awp(s)).not.toThrow();
  });

  it('reads the four roots', () => {
    const path = (s: string) => awp(s) as WhenPath;
    expect(path('inputs.x')).toMatchObject({ root: 'input', name: 'x', segments: [] });
    expect(path('steps.a-b.outputs.o.p[2]')).toMatchObject({
      root: 'step',
      step: 'a-b',
      name: 'o',
      segments: ['p', 2],
    });
    expect(path('event')).toMatchObject({ root: 'event', segments: [] });
    expect(path('execution.environment')).toMatchObject({ root: 'execution', name: 'environment' });
  });

  it.each([
    ['steps.a.output.x == 1', 'agents.md root form'],
    ["inputs.x == 'a'", 'single quoted string'],
    ['inputs.x == "a\\q"', 'escape that is not JSON'],
    ['inputs.x == "a\tb"', 'raw control character'],
    ['execution.region == "x"', 'execution.region'],
    ['secrets.token == "x"', 'unknown root'],
    ['inputs.__proto__.x == 1', 'prototype segment after the root'],
    ['inputs.a.constructor == 1', 'constructor segment'],
    ['steps.a.outputs.prototype == 1', 'prototype output name'],
    ['inputs.a == 1 == 2', 'chained comparison'],
  ])('rejects %s (%s)', (s, why) => {
    expect(failure(s), why).toBeInstanceOf(WhenError);
    expect(failure(s).limit).toBe(false);
  });

  it('marks limit violations so the validator can use when.limits', () => {
    expect(failure('inputs.a == "' + 'x'.repeat(257) + '"').limit).toBe(true);
    expect(failure('['.repeat(1) + 'x'.repeat(520)).limit).toBe(true);
    expect(failure('inputs.a in [' + Array(33).fill('1').join(',') + ']').limit).toBe(true);
    expect(failure('inputs.a[10001] == 1').limit).toBe(true);
    expect(failure('inputs.a' + '.b'.repeat(17) + ' == 1').limit).toBe(true);
    expect(failure('!'.repeat(17) + 'inputs.a').limit).toBe(true);
    expect(failure('(('.repeat(9) + 'inputs.a' + '))'.repeat(9)).limit).toBe(true);
    expect(failure(Array(70).fill('true').join('&&')).limit).toBe(true);
  });

  it('does not run a condition of the awp dialect', () => {
    expect(() => evaluateWhen('inputs.x == 1', { event: {}, steps: {} })).toThrowError(
      /condition does not parse/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Mapping agents.md -> AEP-0001
// ---------------------------------------------------------------------------------------------

const map = (s: string, hasEvent = true) => {
  const r = toAwpWhen(s, hasEvent);
  if (!r.ok) throw new Error(r.reason);
  return r.expression;
};

/** Maps an AEP AST back to the agents.md shape, to prove that the rewrite keeps the structure. */
function back(n: WhenNode): WhenNode {
  switch (n.type) {
    case 'path':
      return backPath(n);
    case 'exists':
      return { type: 'exists', path: backPath(n.path) };
    case 'not':
      return { type: 'not', operand: back(n.operand) };
    case 'and':
    case 'or':
    case 'compare':
      return { ...n, left: back(n.left), right: back(n.right) };
    default:
      return n;
  }
}
function backPath(p: WhenPath): WhenPath {
  if (p.root === 'step')
    return { type: 'path', root: 'step', step: p.step as string, segments: p.segments };
  return { type: 'path', root: 'event', segments: ['data', ...p.segments] };
}

describe('mapping to the AEP grammar', () => {
  it.each([
    [
      'steps.analysis.output.severity in ["high", "critical"]',
      'steps.analysis.outputs.result.severity in ["high", "critical"]',
    ],
    ["steps.a.output.items[0].name == 'x'", 'steps.a.outputs.result.items[0].name == "x"'],
    [
      'event.data.kind == "pr" && exists(event.data.draft)',
      'inputs.event.kind == "pr" && exists(inputs.event.draft)',
    ],
    ['exists(event.data)', 'exists(inputs.event)'],
    [
      '!(steps.a.output.ok == true) || steps.b.output.n >= 3',
      '!steps.a.outputs.result.ok == true || steps.b.outputs.result.n >= 3',
    ],
    ['!steps.a.output.ok', '!steps.a.outputs.result.ok'],
    [
      '(steps.a.output.x == 1 || steps.a.output.y == 2) && steps.a.output.z == 3',
      '(steps.a.outputs.result.x == 1 || steps.a.outputs.result.y == 2) && steps.a.outputs.result.z == 3',
    ],
    [
      'steps.a.output.x == 1 || (steps.a.output.y == 2 || steps.a.output.z == 3)',
      'steps.a.outputs.result.x == 1 || (steps.a.outputs.result.y == 2 || steps.a.outputs.result.z == 3)',
    ],
    ['"a\\"b" == steps.a.output.s', '"a\\"b" == steps.a.outputs.result.s'],
    ['(steps.a.output.x == 1) == true', '(steps.a.outputs.result.x == 1) == true'],
    [
      'steps.a.output.v in [1, -2.5, null, false, "z"]',
      'steps.a.outputs.result.v in [1, -2.5, null, false, "z"]',
    ],
  ])('%s', (source, expected) => {
    const out = map(source);
    expect(out).toBe(expected);
    // The result is valid in the AEP grammar and has the same structure as the source.
    expect(back(awp(out))).toEqual(parseWhen(source));
  });

  it('refuses what has no AEP counterpart, with a reason', () => {
    const noEvent = toAwpWhen('event.data.x == 1', false);
    expect(noEvent).toMatchObject({ ok: false });
    expect((noEvent as { reason: string }).reason).toMatch(/no event trigger/);
    for (const s of ['event.type == "x"', 'exists(event)', 'event.source == "s"', 'event[0] == 1'])
      expect(toAwpWhen(s, true), s).toMatchObject({ ok: false });
  });

  it('refuses a condition that does not parse or no longer fits an AEP limit after the rewrite', () => {
    expect(toAwpWhen('steps.a.output ==', true)).toMatchObject({ ok: false });
    // 128 tokens: the longer path form (outputs.result) adds two tokens per step path.
    const many = Array(15).fill('steps.a.output.x').join(' || ');
    expect(() => parseWhen(many)).not.toThrow();
    const r = toAwpWhen(many, true);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/exceeds an AWP limit/);
  });

  it('never executes anything: hostile text is parsed or refused', () => {
    for (const s of [
      'constructor.constructor("x")()',
      'steps.a.output.__proto__.x == 1',
      '${{ secrets.x }}',
    ])
      expect(toAwpWhen(s, true)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------------------------

/** Two agents in a pipeline; `b` is conditional on the output of `a`. */
const twoSteps = (when: string | undefined, hasEvent = false) =>
  probe((o) => {
    o.agents.push({
      id: 'b',
      provider: 'simulated',
      model: 'sim-1',
      instructions: 'Comment.',
      ...(when !== undefined ? { when } : {}),
    });
    o.pipeline = ['a', 'b'];
    if (hasEvent) o.triggers = [{ type: 'webhook', source: 'trivy' }];
  });

const manifestOf = (r: ReturnType<typeof exportOf>): Obj => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.findings)}`);
  return r.manifest as Obj;
};
const stepOf = (m: Obj, i: number) => ((m.spec as Obj).workflow as Obj[])[i]!;

/** The pinned schema as it would look with AEP-0011 and AEP-0001 (a test-only copy, never vendored). */
function futureSchema(): Record<string, unknown> {
  const s = structuredClone(AWP_SCHEMA) as {
    $defs: { Metadata: { properties: Obj }; Step: { properties: Obj } };
  };
  s.$defs.Metadata.properties.requiredExtensions = { type: 'array', items: { type: 'string' } };
  s.$defs.Step.properties.when = { type: 'string', minLength: 1, maxLength: 512 };
  return s;
}
const validate = (m: unknown, schemas?: { awp: Record<string, unknown> }) =>
  validateManifestSource(JSON.stringify(m), {
    layout: 'document',
    ...(schemas ? { schemas } : {}),
  })!;
const errorCodes = (r: { findings: ManifestFinding[] }) =>
  r.findings.filter((f) => f.severity === 'error').map((f) => `${f.code} ${f.path}`);

describe('export of step conditions', () => {
  it('is refused while the pin has neither requiredExtensions nor step.when (decision D3)', () => {
    const r = exportOf(twoSteps('steps.a.output.severity in ["high"]'));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.findings).toEqual([
        expect.objectContaining({
          code: 'critical_extension',
          field: 'when',
          extension: 'x-openagentix-when',
          path: 'agents.1.when',
        }),
      ]);
  });

  it('writes the extension, listed in requiredExtensions, in the AEP grammar', () => {
    const m = manifestOf(
      exportOf(twoSteps('steps.a.output.severity in ["high"]'), {
        requiredExtensionsSupported: true,
      }),
    );
    expect(stepOf(m, 1)['x-openagentix-when']).toBe('steps.a.outputs.result.severity in ["high"]');
    expect(stepOf(m, 1)).not.toHaveProperty('when');
    expect((m.metadata as Obj).requiredExtensions).toEqual(['x-openagentix-when']);
    expect(stepOf(m, 1).dependsOn).toEqual(['a']);
    expect(stepOf(m, 0)).not.toHaveProperty('x-openagentix-when');
    // and a validator that knows requiredExtensions accepts it with no finding on the condition
    const r = validate(m, { awp: futureSchema() });
    expect(errorCodes(r)).toEqual([]);
  });

  it('writes the core field once the pinned schema offers it (fixture schema, not vendored)', () => {
    const def = twoSteps('steps.a.output.severity in ["high"]');
    const m = manifestOf(exportOf(def, { stepWhenSupported: true }));
    expect(stepOf(m, 1).when).toBe('steps.a.outputs.result.severity in ["high"]');
    expect(stepOf(m, 1)).not.toHaveProperty('x-openagentix-when');
    expect((m.metadata as Obj).requiredExtensions).toBeUndefined();
    expect(errorCodes(validate(m, { awp: futureSchema() }))).toEqual([]);
    // against the real pinned schema the field is unknown, so the manifest is not accepted by it
    expect(pinErrors(m, ['core']).join('\n')).toMatch(/additional properties/);
  });

  it('maps event.data to the input "event" of an event-triggered workflow', () => {
    const m = manifestOf(
      exportOf(twoSteps('event.data.kind == "pr"', true), { requiredExtensionsSupported: true }),
    );
    expect(stepOf(m, 1)['x-openagentix-when']).toBe('inputs.event.kind == "pr"');
    expect(errorCodes(validate(m, { awp: futureSchema() }))).toEqual([]);
  });

  it('refuses a condition it cannot map, even when extensions are supported', () => {
    for (const opts of [{ requiredExtensionsSupported: true }, { stepWhenSupported: true }, {}]) {
      const r = exportOf(twoSteps('event.type == "x"', true), opts);
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.findings.map((f) => `${f.code} ${f.path}`)).toContain(
          'condition_not_representable agents.1.when',
        );
    }
    const noEvent = exportOf(twoSteps('event.data.x == 1', false), { stepWhenSupported: true });
    expect(noEvent.ok).toBe(false);
  });

  it('pins the feature flag to the vendored schema', () => {
    const step = (AWP_SCHEMA as { $defs: { Step: { properties: Obj } } }).$defs.Step.properties;
    expect(PINNED_AWP_FEATURES.stepWhen).toBe('when' in step);
  });
});

// ---------------------------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------------------------

function manifestWith(patch: (steps: Obj[], spec: Obj, metadata: Obj) => void): Obj {
  const m = manifestOf(exportOf(twoSteps('steps.a.output.k == 1'), { stepWhenSupported: true }));
  const spec = m.spec as Obj;
  const steps = spec.workflow as Obj[];
  steps[0]!.outputs = [{ name: 'result' }, { name: 'other' }];
  patch(steps, spec, m.metadata as Obj);
  delete (m.metadata as Obj).integrity;
  return m;
}
const check = (m: Obj) => validate(m, { awp: futureSchema() });

describe('validator rules for step conditions (AEP-0001 section 3.10)', () => {
  it('accepts a condition on a transitive dependency and on a declared output', () => {
    const r = check(
      manifestWith((steps) => {
        steps.push({ id: 'c', agent: 'a', dependsOn: ['b'], when: 'steps.a.outputs.other == 1' });
      }),
    );
    expect(errorCodes(r)).toEqual([]);
  });

  it.each([
    ['when.syntax', 'steps.a.outputs.result =='],
    ['when.syntax', 'steps.a.outputs.result.__proto__ == 1'],
    ['when.syntax', 'steps.a.output.k == 1'],
    ['when.limits', 'inputs.a == "' + 'x'.repeat(300) + '"'],
    ['when.unknown-step', 'steps.nope.outputs.result == 1'],
    ['when.not-a-dependency', 'steps.b.outputs.result == 1'],
    ['when.undeclared-output', 'steps.a.outputs.missing == 1'],
  ])('%s: %s', (code, text) => {
    const r = check(manifestWith((steps) => (steps[1]!.when = text)));
    expect(errorCodes(r)).toEqual([`${code} /spec/workflow/1/when`]);
  });

  it('applies the same rules to the extension, at its own path', () => {
    const r = check(
      manifestWith((steps, _spec, metadata) => {
        delete steps[1]!.when;
        steps[1]!['x-openagentix-when'] = 'steps.a.outputs.missing == 1';
        metadata.requiredExtensions = ['x-openagentix-when'];
      }),
    );
    expect(errorCodes(r)).toEqual(['when.undeclared-output /spec/workflow/1/x-openagentix-when']);
  });

  it('a step reading itself does not depend on itself', () => {
    const r = check(manifestWith((steps) => (steps[1]!.when = 'steps.b.outputs.result == 1')));
    expect(errorCodes(r)).toEqual(['when.not-a-dependency /spec/workflow/1/when']);
  });

  it('warns about an undeclared input and accepts a declared one', () => {
    const warn = check(manifestWith((steps) => (steps[1]!.when = 'inputs.ticket == "T"')));
    expect(errorCodes(warn)).toEqual([]);
    expect(warn.findings.map((f) => `${f.severity} ${f.code}`)).toContain(
      'warning when.undeclared-input',
    );
    const ok = check(
      manifestWith((steps, spec) => {
        steps[1]!.when = 'inputs.ticket == "T"';
        spec.inputs = [{ name: 'ticket', type: 'string' }];
      }),
    );
    expect(ok.findings.map((f) => f.code)).not.toContain('when.undeclared-input');
  });

  it('terminates on cyclic dependencies', () => {
    const r = check(
      manifestWith((steps) => {
        steps[0]!.dependsOn = ['b'];
        steps[1]!.when = 'steps.a.outputs.result == 1';
      }),
    );
    expect(errorCodes(r)).toContain('dependsOn.cycle /spec/workflow/1/dependsOn');
  });

  it('with the pinned schema the core field is a structural error (unknown member)', () => {
    const m = manifestWith(() => undefined);
    const r = validate(m);
    expect(errorCodes(r)).toContain('schema.additionalProperties /spec/workflow/1/when');
  });
});

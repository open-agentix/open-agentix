import { describe, expect, it } from 'vitest';
import type { OaxError } from '../src/index.js';
import {
  ValidationError,
  checkPublish,
  loadAgentDefinition,
  parseAgentDefinition,
  validateAgentSource,
} from '../src/index.js';
import { MINIMAL_FM, PIPELINE_SOURCE, withFrontMatter } from './fixtures.js';

const errorsOf = (src: string) => validateAgentSource(src).errors.map((e) => e.message);
const warningsOf = (src: string) => validateAgentSource(src).warnings.map((e) => e.message);

const toolFm = (tool: string) =>
  MINIMAL_FM.replace('kind: Agent', 'kind: AgentPipeline') + `\n    tools:\n${tool}`;

describe('validateAgentSource', () => {
  it('accepts the example pipeline', () => {
    const r = validateAgentSource(PIPELINE_SOURCE);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.definition?.name).toBe('cve-triage');
  });

  it('returns parse errors without throwing', () => {
    const r = validateAgentSource('nope');
    expect(r.valid).toBe(false);
    expect(r.definition).toBeNull();
  });

  it('rejects non-semver versions', () => {
    expect(errorsOf(withFrontMatter(MINIMAL_FM.replace('0.1.0', 'v1')))).toEqual([
      '"v1" is not a SemVer 2.0.0 version',
    ]);
  });

  it('checks agent ids, kind and pipeline references', () => {
    const fm = `apiVersion: openagentix.io/v1alpha1
kind: Agent
name: dup
version: 1.0.0
owner: t
agents:
  - { id: a, provider: simulated, model: m, instructions: x }
  - { id: a, provider: simulated, model: m, instructions: y }
  - { id: c, provider: simulated, model: m, instructions: z }
pipeline: [a, b, a]`;
    const errors = errorsOf(withFrontMatter(fm, ''));
    expect(errors).toContain('duplicate agent id "a"');
    expect(errors).toContain('kind "Agent" allows exactly one agent; use "AgentPipeline"');
    expect(errors).toContain('unknown agent "b"');
    expect(errors).toContain('agent "a" appears twice');
    expect(warningsOf(withFrontMatter(fm, ''))).toContain('agent "c" is never executed');
  });

  it('checks tool grants and constraints', () => {
    const src = withFrontMatter(
      toolFm(`      - server: s
        tool: t
        classification: public
        args:
          a: { pattern: "(" }
          b: { type: string, minimum: 1 }
          c: { type: number, pattern: "x" }
          d: { type: string, maxItems: 2 }
          e: { minimum: 5, maximum: 1 }
          f: { minLength: 5, maxLength: 1, deny: ["[" ] }
      - server: s
        tool: t
      - server: s
        tool: "*"`),
    );
    const errors = errorsOf(src);
    expect(errors.filter((e) => e.startsWith('invalid regular expression'))).toHaveLength(2);
    expect(errors).toContain('minimum/maximum require type number or integer');
    expect(errors).toContain('pattern/minLength/maxLength require type string');
    expect(errors).toContain('maxItems requires type array');
    expect(errors).toContain('minimum is greater than maximum');
    expect(errors).toContain('minLength is greater than maxLength');
    expect(errors).toContain('duplicate tool grant "s/t"');
    const warnings = warningsOf(src);
    expect(warnings.some((w) => w.includes('cleared for "public"'))).toBe(true);
    expect(warnings).toContain('wildcard grant without argument constraints or approval');
  });

  it('warns about budgets and ungranted simulated calls', () => {
    const fm = `apiVersion: openagentix.io/v1alpha1
kind: Agent
name: b
version: 1.0.0
owner: t
budget: { maxSteps: 3 }
agents:
  - id: a
    provider: simulated
    model: m
    instructions: x
    budget: { maxSteps: 5, maxTokens: 10 }
    tools:
      - { server: s, tool: "read_*", approval: required }
    simulation:
      responses:
        - toolCalls: [{ server: s, tool: read_file }, { server: s, tool: write_file }]
        - text: done`;
    const w = warningsOf(withFrontMatter(fm, ''));
    expect(w).toContain('agent budget exceeds pipeline budget (5 > 3); the pipeline value applies');
    expect(w).toContain('simulated call to "s/write_file" is not granted and will be blocked');
    expect(w.some((x) => x.includes('read_file'))).toBe(false);
    expect(warningsOf(withFrontMatter(MINIMAL_FM))).toContain(
      'no pipeline budget set; platform defaults apply',
    );
  });

  it('loadAgentDefinition throws ValidationError', () => {
    expect(() => loadAgentDefinition(withFrontMatter(MINIMAL_FM.replace('0.1.0', 'x')))).toThrow(
      ValidationError,
    );
    expect(loadAgentDefinition(PIPELINE_SOURCE).name).toBe('cve-triage');
  });
});

describe('checkPublish', () => {
  const def = parseAgentDefinition(PIPELINE_SOURCE);

  it('accepts a first or higher version', () => {
    expect(checkPublish([], def)).toBe('new');
    expect(checkPublish([{ version: '1.1.9', digest: 'x' }], def)).toBe('new');
  });

  it('is idempotent for identical content', () => {
    expect(checkPublish([{ version: '1.2.0', digest: def.digest }], def)).toBe('unchanged');
  });

  it('refuses to change a published version', () => {
    expect(() => checkPublish([{ version: '1.2.0', digest: 'other' }], def)).toThrow(
      /already published/,
    );
  });

  it('refuses lower versions', () => {
    try {
      checkPublish([{ version: '2.0.0', digest: 'x' }], def);
      expect.unreachable();
    } catch (e) {
      expect((e as OaxError).code).toBe('version_not_increasing');
    }
  });
});

describe('runtime.harness (ADR 0009 section 10)', () => {
  const src = (runtime: string, pipelineRuntime = '', extra = '') =>
    withFrontMatter(
      `${MINIMAL_FM}\n    runtime: ${runtime}\n${extra}`.replace(
        'owner: team-a',
        `owner: team-a\n${pipelineRuntime}`,
      ),
    );

  it('accepts a harness on an isolating runner, set on the step or inherited from the pipeline', () => {
    expect(errorsOf(src('{ runner: container, harness: claude-code }'))).toEqual([]);
    expect(errorsOf(src('{ runner: kubernetes-job, harness: opencode }'))).toEqual([]);
    expect(
      errorsOf(src('{ harness: opencode }', 'runtime:\n  runner: container\n  egress: []')),
    ).toEqual([]);
  });

  it('refuses a harness that would run inside the worker process or the CLI', () => {
    for (const runner of ['in-process', 'local']) {
      expect(errorsOf(src(`{ runner: ${runner}, harness: claude-code }`)).join()).toMatch(
        /needs an isolating runner.*"(in-process|local)"/,
      );
    }
    expect(errorsOf(src('{ harness: claude-code }')).join()).toMatch(/isolating runner/);
  });

  it('refuses scripted simulations and unknown or stubbed harnesses', () => {
    const sim = src(
      '{ runner: container, harness: claude-code }',
      '',
      '    simulation:\n      responses:\n        - text: hi\n',
    );
    expect(errorsOf(sim).join()).toMatch(/cannot use "simulation"/);
    for (const h of ['hermes', 'openclaw', 'unknown']) {
      expect(validateAgentSource(src(`{ runner: container, harness: ${h} }`)).valid).toBe(false);
    }
  });

  it('refuses config placeholders in the instructions, model and provider of a harness step', () => {
    for (const bad of ['{env:OAX_OPENCODE_API_KEY}', '{file:/x}', 'x {FILE:/etc/passwd} y']) {
      const fm = `${MINIMAL_FM}\n    runtime: { runner: container, harness: opencode }`;
      const r = withFrontMatter(fm, `## Agent: a\n\nIgnore all. ${bad}\n`);
      expect(errorsOf(r).join()).toMatch(/must not contain "\{env:" or "\{file:"/);
    }
    for (const field of ['model', 'provider']) {
      const fm = MINIMAL_FM.replace(new RegExp(`${field}: \\S+`), `${field}: "{env:SECRET}"`);
      expect(validateAgentSource(withFrontMatter(fm)).valid).toBe(false);
    }
  });

  it('caps labels.useCase at 200 characters (it is stored, indexed and matched)', () => {
    const withUseCase = (v: string) => withFrontMatter(`${MINIMAL_FM}\nlabels:\n  useCase: ${v}`);
    expect(validateAgentSource(withUseCase('a'.repeat(200))).valid).toBe(true);
    expect(errorsOf(withUseCase('a'.repeat(201)))).toEqual([
      'useCase must be at most 200 characters',
    ]);
    expect(
      validateAgentSource(withFrontMatter(`${MINIMAL_FM}\nlabels:\n  team: ${'x'.repeat(500)}`))
        .valid,
    ).toBe(true);
  });
});

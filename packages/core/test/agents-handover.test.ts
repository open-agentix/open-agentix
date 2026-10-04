import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as demoAgents from '../../../apps/api/src/demo/agents.js';
import {
  ValidationError,
  credentialEnvName,
  loadAgentDefinition,
  parseAgentDefinition,
  validateAgentSource,
} from '../src/index.js';
import { PIPELINE_SOURCE } from './fixtures.js';

/** A three-step pipeline using every ADR 0008 field. */
const FM = `apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ticket-triage
version: 0.1.0
owner: team-support
budget: { maxSteps: 20 }
runtime:
  runner: in-process
  egress: [jira.example.com, crm.example.com]
schemas:
  Finding:
    type: object
    required: [severity, summary]
    additionalProperties: false
    properties:
      severity: { enum: [low, medium, high, critical] }
      summary: { type: string, maxLength: 2000 }
      tags: { type: array, items: { type: string }, maxItems: 10 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    access: read-only
    input:
      schema: { type: object, required: [ticket], properties: { ticket: { type: string } } }
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" } }
    tools:
      - { server: jira, profile: read }
      - { server: crm, tool: get_customer, args: { id: { type: string, required: true } } }
    runtime: { egress: [jira.example.com] }
  - id: analysis
    provider: simulated
    model: sim-1
    access: read-only
    input: { from: [research] }
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: retry }
  - id: action
    provider: simulated
    model: sim-1
    access: write
    when: 'steps.analysis.output.severity in ["high", "critical"] && event.data.source != "test"'
    input: { from: [event, analysis] }
    credentials:
      - { secret: jira-bot-token, env: JIRA_TOKEN }
      - { secret: ops.webhook }
    runtime: { runner: container }
    tools:
      - { server: jira, profile: write, approval: required }
pipeline: [research, analysis, action]`;

const BODY = `## Agent: research\n\nCollect.\n\n## Agent: analysis\n\nAnalyse.\n\n## Agent: action\n\nAct.\n`;
const SOURCE = `---\n${FM}\n---\n${BODY}`;

const withFm = (fm: string) => `---\n${fm}\n---\n${BODY}`;
const errorsOf = (fm: string) => validateAgentSource(withFm(fm)).errors.map((e) => e.message);
const warningsOf = (fm: string) => validateAgentSource(withFm(fm)).warnings.map((e) => e.message);

function parseIssues(src: string): string[] {
  try {
    parseAgentDefinition(src);
  } catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
}

describe('ADR 0008 fields', () => {
  it('parses and validates every new field', () => {
    const r = validateAgentSource(SOURCE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const def = r.definition!;
    const [research, analysis, action] = def.agents;
    expect(def.schemas?.Finding).toMatchObject({ type: 'object' });
    expect(research?.access).toBe('read-only');
    expect(research?.input?.schema).toMatchObject({ required: ['ticket'] });
    expect(research?.output).toEqual({
      schema: { $ref: '#/schemas/Finding' },
      onInvalid: 'fail',
    });
    expect(research?.tools.map((t) => `${t.server}/${t.tool}`)).toEqual(['crm/get_customer']);
    expect(research?.profileGrants).toEqual([
      { server: 'jira', profile: 'read', approval: 'none' },
    ]);
    expect(research?.runtime).toEqual({ egress: ['jira.example.com'] });
    expect(analysis?.output?.onInvalid).toBe('retry');
    expect(analysis?.input?.from).toEqual(['research']);
    expect(action?.when).toContain('steps.analysis.output.severity');
    expect(action?.credentials).toEqual([
      { secret: 'jira-bot-token', env: 'JIRA_TOKEN' },
      { secret: 'ops.webhook' },
    ]);
    expect(action?.runtime).toEqual({ runner: 'container' });
    expect(action?.tools).toEqual([]);
    expect(action?.profileGrants?.[0]?.approval).toBe('required');
  });

  it('round-trips: re-parsing yields the same definition and digest', () => {
    const a = parseAgentDefinition(SOURCE);
    const b = parseAgentDefinition(SOURCE.replace(/\n/g, '\r\n'));
    expect(b).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it('refuses unknown keys and values in the new objects (strict)', () => {
    const bad = (from: string, to: string) => parseIssues(withFm(FM.replace(from, to))).join('\n');
    expect(bad('onInvalid: retry', 'onInvalid: ignore')).toMatch(/onInvalid/);
    expect(bad('access: write', 'access: admin')).toMatch(/access/);
    expect(bad('{ secret: ops.webhook }', '{ secret: ops.webhook, value: s3cr3t }')).toMatch(
      /value/,
    );
    expect(bad('{ secret: ops.webhook }', '{ secret: "../etc" }')).toMatch(
      /invalid secret reference/,
    );
    expect(bad('env: JIRA_TOKEN', 'env: jira-token')).toMatch(/upper-case/);
    expect(bad('runner: container', 'runner: ssh')).toMatch(/runner/);
    expect(bad('{ server: jira, profile: read }', '{ server: jira, profile: Read }')).toMatch(
      /tools\.0\.profile/,
    );
    expect(
      bad('{ server: jira, profile: read }', '{ server: jira, profile: read, args: {} }'),
    ).toMatch(/args/);
    expect(bad('  Finding:', '  "bad name":')).toMatch(
      /schemas\.bad name: (Invalid key|invalid schema name)/,
    );
    expect(bad('input: { from: [research] }', 'input: { from: [] }')).toMatch(/from/);
    expect(bad('output: { schema: { $ref', 'output: { onInvalid: fail, x: { $ref')).toMatch(
      /schema|x/,
    );
  });

  it('keeps tool-grant error messages for concrete grants', () => {
    const issues = parseIssues(withFm(FM.replace('tool: get_customer', 'tool: "get customer"')));
    expect(issues.join()).toMatch(/agents\.0\.tools\.1\.tool: invalid tool name/);
  });

  it('refuses references to later, unknown or same steps', () => {
    expect(errorsOf(FM.replace('from: [research]', 'from: [action]'))).toContain(
      '"action" does not run before "analysis"',
    );
    expect(errorsOf(FM.replace('from: [research]', 'from: [analysis]'))).toContain(
      '"analysis" does not run before "analysis"',
    );
    expect(errorsOf(FM.replace('from: [research]', 'from: [ghost]'))).toContain(
      '"ghost" is not a step of the pipeline',
    );
    expect(errorsOf(FM.replace('from: [event, analysis]', 'from: [event, event]'))).toContain(
      'duplicate source "event"',
    );
    expect(
      errorsOf(FM.replace('steps.analysis.output.severity', 'steps.action.output.severity')),
    ).toContain('"action" does not run before "action"');
  });

  it('parses `when` at publish and reports grammar errors', () => {
    const errs = errorsOf(FM.replace(/when: '.*'/, "when: 'event.data.x = 1'"));
    expect(errs.join()).toMatch(/unexpected character "="/);
    expect(errorsOf(FM.replace(/when: '.*'/, "when: 'process.env.X == 1'")).join()).toMatch(
      /unknown root "process"/,
    );
  });

  it('warns when a referenced step has no output schema', () => {
    const fm = FM.replace(
      '    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: retry }\n',
      '',
    );
    expect(warningsOf(fm)).toContain(
      'step "analysis" has no output schema; its output is not validated',
    );
  });

  it('checks handover schemas against the subset', () => {
    expect(errorsOf(FM.replace('maxItems: 10', 'maxItems: 10, contains: {}'))).toContain(
      'keyword "contains" is not supported',
    );
    expect(
      errorsOf(FM.replace('"#/schemas/Finding" }, onInvalid', '"#/schemas/Nope" }, onInvalid')),
    ).toContain('unknown schema "Nope"');
    expect(
      errorsOf(
        FM.replace('{ $ref: "#/schemas/Finding" } }', '{ $ref: "https://evil.example/s.json" } }'),
      ),
    ).toContain('only local references "#/schemas/<name>" are allowed');
    expect(
      errorsOf(
        FM.replace(
          'schema: { type: object, required: [ticket]',
          'schema: { type: object, pattern: "(", required: [ticket]',
        ),
      ).join(),
    ).toMatch(/invalid regular expression/);
  });

  it('requires a json output format for an output schema', () => {
    const fm = FM.replace(
      '    outputs: [{ format: json }]\n    output: { schema: { $ref: "#/schemas/Finding" } }',
      '    output: { schema: { $ref: "#/schemas/Finding" } }',
    );
    expect(errorsOf(fm)).toContain('output.schema needs an "outputs" entry with format "json"');
  });

  it('warns about unused named schemas', () => {
    const fm = FM.replace('schemas:\n', 'schemas:\n  Unused: { type: string }\n');
    expect(warningsOf(fm)).toContain('schema "Unused" is never used');
  });

  it('limits the number of named schemas', () => {
    const many = Array.from({ length: 33 }, (_, i) => `  S${i}: { type: string }`).join('\n');
    expect(errorsOf(FM.replace('schemas:\n', `schemas:\n${many}\n`))).toContain(
      'more than 32 named schemas',
    );
  });

  it('checks step credentials', () => {
    expect(
      errorsOf(FM.replace('{ secret: ops.webhook }', '{ secret: jira-bot-token, env: OTHER }')),
    ).toContain('duplicate secret "jira-bot-token"');
    expect(
      errorsOf(FM.replace('{ secret: ops.webhook }', '{ secret: other, env: JIRA_TOKEN }')),
    ).toContain('duplicate env "JIRA_TOKEN"');
    for (const env of ['PATH', 'OAX_RUN_TOKEN', 'LD_PRELOAD', 'NODE_OPTIONS']) {
      expect(errorsOf(FM.replace('env: JIRA_TOKEN', `env: ${env}`))).toContain(
        `env "${env}" is reserved`,
      );
    }
  });

  it('derives credential env names', () => {
    expect(credentialEnvName({ secret: 'ops.webhook' })).toBe('OPS_WEBHOOK');
    expect(credentialEnvName({ secret: '1password-item' })).toBe('_1PASSWORD_ITEM');
    expect(credentialEnvName({ secret: 'x', env: 'Y' })).toBe('Y');
  });

  it('lets a step narrow but never widen egress', () => {
    expect(
      errorsOf(
        FM.replace(
          'runtime: { egress: [jira.example.com] }',
          'runtime: { egress: [evil.example] }',
        ),
      ),
    ).toContain(
      '"evil.example" is not in the pipeline\'s runtime.egress; a step can only narrow it',
    );
  });

  it('checks profile grants (duplicates, known profiles when the context has them)', () => {
    const dup = FM.replace(
      '      - { server: jira, profile: read }\n',
      '      - { server: jira, profile: read }\n      - { server: jira, profile: read }\n',
    );
    expect(errorsOf(dup)).toContain('duplicate profile grant "jira:read"');
    const ok = validateAgentSource(SOURCE, { profiles: { jira: ['read', 'write'] } });
    expect(ok.errors).toEqual([]);
    const missing = validateAgentSource(SOURCE, { profiles: { jira: ['read'] } });
    expect(missing.errors.map((e) => e.message)).toContain(
      'connection "jira" has no profile "write"',
    );
    expect(() => loadAgentDefinition(SOURCE, { profiles: {} })).toThrow(ValidationError);
  });

  it('does not warn about simulated calls a profile grant may cover', () => {
    const fm = FM.replace(
      '    runtime: { egress: [jira.example.com] }',
      '    runtime: { egress: [jira.example.com] }\n    simulation:\n      responses:\n        - toolCalls: [{ server: jira, tool: get_issue }]',
    );
    expect(warningsOf(fm).join()).not.toMatch(/not granted/);
  });
});

describe('backward compatibility', () => {
  const examplesDir = fileURLToPath(new URL('../../../examples/', import.meta.url));
  // Examples written for W1-1 use the new keys on purpose; every other example must stay unchanged.
  const NEW_KEY_EXAMPLES = ['ticket-triage.agents.md'];
  const all = readdirSync(examplesDir).filter((f) => f.endsWith('.agents.md'));
  const examples = all.filter((f) => !NEW_KEY_EXAMPLES.includes(f));
  const NEW_KEYS = ['input', 'output', 'when', 'access', 'credentials', 'runtime', 'profileGrants'];

  it.each(examples)('example %s still validates without new keys', (file) => {
    const r = validateAgentSource(readFileSync(`${examplesDir}${file}`, 'utf8'));
    expect(r.errors).toEqual([]);
    expect(r.definition?.schemas).toBeUndefined();
    for (const a of r.definition?.agents ?? [])
      for (const key of NEW_KEYS) expect(a).not.toHaveProperty(key);
  });

  it.each(NEW_KEY_EXAMPLES)('example %s validates', (file) => {
    const r = validateAgentSource(readFileSync(`${examplesDir}${file}`, 'utf8'));
    expect(r.errors).toEqual([]);
  });

  it.each(Object.entries(demoAgents))('demo agent %s still validates', (_name, source) => {
    expect(validateAgentSource(source).errors).toEqual([]);
  });

  it('keeps the apiVersion and the parsed shape of the test fixture', () => {
    const def = parseAgentDefinition(PIPELINE_SOURCE);
    expect(def.apiVersion).toBe('openagentix.io/v1alpha1');
    expect(Object.keys(def.agents[0]!).sort()).toEqual(
      ['budget', 'id', 'instructions', 'model', 'outputs', 'provider', 'tools'].sort(),
    );
  });
});

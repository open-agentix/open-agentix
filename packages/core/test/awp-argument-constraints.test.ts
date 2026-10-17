import { describe, expect, it } from 'vitest';
import {
  REGEX_INPUT_LIMIT,
  REGEX_WORK_BUDGET,
  MAX_PATTERN_CHARS,
  isCachedLinear,
  checkPatternList,
  compileLinear,
  resetLinearCache,
  usesDotOrSpaceClass,
  ToolGrantSchema,
  argConstraintIssues,
  checkArg,
  checkRegexSource,
  evaluateToolCall,
  expandProfiles,
  validateAgentSource,
  validateManifestSource,
  verifyNoWidening,
  type AccessCatalog,
  type ManifestFinding,
  type PublishedDefinition,
} from '../src/index.js';
import { AWP_SCHEMA } from '../src/awp/generated/awp-schema.js';
import { PINNED_AWP_FEATURES } from '../src/awp/types.js';
import { exportOf, probe } from './awp-fixtures.js';
import { pinErrors } from './awp-pin.js';

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Regular expressions (AEP-0002 rule 4)
// ---------------------------------------------------------------------------------------------

describe('checkRegexSource', () => {
  it.each(['^SEC-[0-9]+$', '^(src|test)/[A-Za-z0-9._/-]{1,200}$', '^v(1|2)-[a-z]+$', '\\d{4}'])(
    'accepts %s',
    (p) => {
      expect(checkRegexSource(p)).toBeNull();
    },
  );

  it.each([
    ['(', 'syntax'],
    ['a{', 'syntax'],
    ['(a)\\1', 'unsafe'],
    ['(?<n>a)\\k<n>', 'unsafe'],
    ['a(?=b)', 'unsafe'],
    ['a(?!b)', 'unsafe'],
    ['(?<=a)b', 'unsafe'],
    ['(?<!a)b', 'unsafe'],
    ['^(a+)+$', 'unsafe'],
    ['^[a-z]+(-[a-z]+)?$', 'unsafe'], // a quantified group, `?` included, that holds a quantifier
    ['^(a|aa)+$', 'ambiguous-repetition'],
    ['^((a|a))*$', 'ambiguous-repetition'],
    ['^(?:(?:a|a))*$', 'ambiguous-repetition'],
    ['^((a|aa))+$', 'ambiguous-repetition'],
    ['^((?:a|b))*$', 'ambiguous-repetition'],
    ['^(x(y|z))+$', 'ambiguous-repetition'],
    ['^(a|a)*$', 'ambiguous-repetition'],
    ['^(x|y){2,}$', 'ambiguous-repetition'],
    ['a'.repeat(1025), 'too-long'],
  ])('refuses %s (%s)', (p, code) => {
    expect(checkRegexSource(p)?.code).toBe(code);
  });

  it('does not mistake a class, an escape or a bounded repeat for an alternation under repetition', () => {
    expect(checkRegexSource('^(a|b)$')).toBeNull();
    expect(checkRegexSource('^(a|b)?c$')).toBeNull();
    expect(checkRegexSource('^(a|b){1}c$')).toBeNull();
    expect(checkRegexSource('^[(|)]+$')).toBeNull();
    expect(checkRegexSource('^\\(a|b\\)+$')).toBeNull();
  });
});

describe('argConstraintIssues', () => {
  const codes = (c: Obj) => argConstraintIssues(c).map((i) => `${i.code}@${i.field}`);

  it('names the rule and the member', () => {
    expect(codes({ pattern: '^a$' })).toEqual(['args.pattern-unbounded@pattern']);
    expect(codes({ pattern: '(', maxLength: 5 })).toEqual(['args.pattern-invalid@pattern']);
    expect(codes({ deny: ['ok', '(a)\\1'], maxLength: 9 })).toEqual([
      'args.pattern-invalid@deny.1',
    ]);
    expect(codes({ type: 'number', pattern: '^a$', maxLength: 3 })).toEqual([
      'args.type-mismatch@',
    ]);
    expect(codes({ type: 'string', minimum: 1 })).toEqual(['args.type-mismatch@']);
    expect(codes({ type: 'object', maxItems: 1 })).toEqual(['args.type-mismatch@']);
    expect(codes({ minimum: 3, maximum: 2 })).toEqual(['args.range@']);
    expect(codes({ minLength: 3, maxLength: 2 })).toEqual(['args.range@']);
    expect(codes({ type: 'string', pattern: '^a$', maxLength: 3 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// agents.md validation
// ---------------------------------------------------------------------------------------------

const fm = (tool: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: t
version: 1.0.0
owner: team-a
agents:
  - id: a
    provider: simulated
    model: m
    instructions: x
    tools:
      - ${tool}
---
`;

describe('agents.md argument constraints', () => {
  const errors = (tool: string) => validateAgentSource(fm(tool)).errors;

  it('requires maxLength next to a pattern and points at the pattern', () => {
    expect(errors('{ server: s, tool: t, args: { k: { pattern: "^a$" } } }')).toEqual([
      expect.objectContaining({ path: 'agents.0.tools.0.args.k.pattern' }),
    ]);
    expect(errors('{ server: s, tool: t, args: { k: { pattern: "^a$", maxLength: 5 } } }')).toEqual(
      [],
    );
  });

  it.each(['(a)\\\\1', 'a(?=b)', '^(a+)+$', '^(a|aa)+$'])('refuses the pattern %s', (p) => {
    expect(
      errors(`{ server: s, tool: t, args: { k: { pattern: "${p}", maxLength: 5 } } }`),
    ).toEqual([expect.objectContaining({ path: 'agents.0.tools.0.args.k.pattern' })]);
  });

  it('applies the regular expression rules to deny patterns too', () => {
    expect(
      errors('{ server: s, tool: t, args: { k: { deny: ["a(?!b)"], maxLength: 9 } } }'),
    ).toEqual([expect.objectContaining({ path: 'agents.0.tools.0.args.k.deny.0' })]);
  });

  it('warns that a prefix wildcard is deprecated', () => {
    const r = validateAgentSource(fm('{ server: s, tool: "get_*", allowAdditionalArgs: true }'));
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(
      /prefix wildcard "get_\*" is deprecated/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Policy engine (run time)
// ---------------------------------------------------------------------------------------------

const grant = (g: unknown) => ToolGrantSchema.parse(g);
const decide = (tool: unknown, args: unknown, counts?: Map<string, number>) =>
  evaluateToolCall(
    { server: 's', tool: 't', args: args as Record<string, unknown> },
    {
      definition: { classification: 'internal' },
      agent: { id: 'a', tools: [grant(tool)] },
      ...(counts ? { callCounts: counts } : {}),
    },
  );
const codesOf = (c: Obj, v: unknown) => checkArg('k', v, c as never).map((r) => r.code);

describe('policy engine: argument constraints fail closed', () => {
  it('denies a bound that does not fit the type of the value instead of ignoring it', () => {
    expect(codesOf({ minimum: 1 }, 'abc')).toEqual(['arg_type']);
    expect(codesOf({ maximum: 1 }, null)).toEqual(['arg_type']);
    expect(codesOf({ maxItems: 1 }, 'abc')).toEqual(['arg_type']);
    expect(codesOf({ maxItems: 1 }, { length: 0 })).toEqual(['arg_type']);
    expect(codesOf({ maxLength: 3 }, 5)).toEqual(['arg_type']);
    expect(codesOf({ minLength: 1 }, ['a'])).toEqual(['arg_type']);
    expect(codesOf({ pattern: '^a$', maxLength: 3 }, 5)).toEqual(['arg_type']);
  });

  it('checks the length in code points, not UTF-16 units', () => {
    const emoji = '😀😀😀'; // 3 code points, 6 UTF-16 units
    expect(codesOf({ maxLength: 3 }, emoji)).toEqual([]);
    expect(codesOf({ maxLength: 2 }, emoji)).toEqual(['arg_length']);
    expect(codesOf({ minLength: 4 }, emoji)).toEqual(['arg_length']);
    expect(codesOf({ maxLength: 1 }, '\ud83d')).toEqual([]); // a lone surrogate counts once
  });

  it('does not run a pattern on text that is already too long, or beyond the runtime limit', () => {
    // A pattern that would take exponential time if it were run against this text.
    const hostile = '^(a+)+$';
    const text = `${'a'.repeat(40)}!`;
    const started = Date.now();
    expect(codesOf({ pattern: hostile, maxLength: 10 }, text)).toEqual(['arg_length']);
    expect(Date.now() - started).toBeLessThan(500);
    const huge = 'a'.repeat(REGEX_INPUT_LIMIT + 1);
    expect(codesOf({ pattern: '^a+$', maxLength: 100_000 }, huge)).toEqual(['arg_length']);
    expect(codesOf({ pattern: '^a+$', maxLength: 100_000 }, 'a'.repeat(REGEX_INPUT_LIMIT))).toEqual(
      [],
    );
  });

  it('denies when a deny rule cannot look at the whole value', () => {
    const huge = 'a'.repeat(REGEX_INPUT_LIMIT + 1);
    expect(codesOf({ deny: ['zzz'] }, huge)).toEqual(['arg_denied']);
    expect(codesOf({ deny: ['zzz'] }, { x: Array.from({ length: 5000 }, () => 'a') })).toEqual([
      'arg_denied',
    ]);
    expect(codesOf({ deny: ['zzz'] }, { x: ['fine'] })).toEqual([]);
    expect(codesOf({ deny: ['zzz'] }, { x: ['zzz'] })).toEqual(['arg_denied']);
  });

  it('never reports the value of an argument', () => {
    const value = 'TOP-SECRET-VALUE-4711';
    const reasons = [
      ...checkArg('k', value, { required: false, pattern: '^A$', maxLength: 5 }),
      ...checkArg('k', value, { required: false, enum: ['a'], deny: ['SECRET'] }),
      ...checkArg('k', value, { required: false, const: 'x', minimum: 3, maxItems: 1 }),
      ...checkArg('k', 99999, { required: false, maximum: 1 }),
    ];
    expect(reasons.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(reasons)).not.toContain('4711');
    expect(JSON.stringify(reasons)).not.toContain('99999');
  });

  it('denies arguments that are not an object when a grant exists', () => {
    const g = { server: 's', tool: 't', allowAdditionalArgs: true };
    for (const args of [['a'], 'text', 5, true])
      expect(decide(g, args).reasons.map((r) => r.code)).toEqual(['arg_type']);
    expect(decide(g, null).effect).toBe('allow');
    expect(decide(g, undefined).effect).toBe('allow');
  });

  it('knows only own properties: toString and __proto__ are not declared arguments', () => {
    const closed = { server: 's', tool: 't', args: { known: { type: 'string' } } };
    for (const name of ['toString', 'constructor', 'hasOwnProperty'])
      expect(decide(closed, { [name]: 'x' }).reasons.map((r) => r.code)).toEqual(['arg_unknown']);
    const proto = JSON.parse('{"__proto__": "x"}') as Obj;
    expect(decide(closed, proto).reasons.map((r) => r.code)).toEqual(['arg_unknown']);
    // a required argument is not satisfied by an inherited property
    const required = { server: 's', tool: 't', args: { toString: { required: true } } };
    expect(decide(required, {}).reasons.map((r) => r.code)).toEqual(['arg_missing']);
  });

  it('counts only started calls against maxCallsPerRun', () => {
    const g = { server: 's', tool: 't', allowAdditionalArgs: true, maxCallsPerRun: 2 };
    expect(decide(g, {}, new Map([['s/t', 1]])).effect).toBe('allow');
    expect(decide(g, {}, new Map([['s/t', 2]])).reasons.map((r) => r.code)).toEqual(['call_limit']);
  });
});

// ---------------------------------------------------------------------------------------------
// Publish: wildcard grants become explicit grants (decision D4)
// ---------------------------------------------------------------------------------------------

const names = (...n: string[]) => n.map((name) => ({ name, inputSchema: {} }));
const conn = (tools: string[], pinned = true): AccessCatalog[string] => ({
  tools: {},
  profiles: {},
  version: 'v1',
  ...(pinned
    ? { pin: { connectionId: 'c', snapshot: { digest: 'd'.repeat(64), tools: names(...tools) } } }
    : {}),
});
const CATALOG: AccessCatalog = {
  logs: conn(['get_a', 'get_b', 'put_c']),
  open: conn([], false),
  unreviewed: {
    tools: {},
    profiles: {},
    version: 'v1',
    pin: { connectionId: 'c', snapshot: null },
  },
};
const withTools = (tools: Obj[]) => probe((o) => (o.agents[0]!.tools = tools));
const publish = (tools: Obj[], catalog = CATALOG) => expandProfiles(withTools(tools), catalog);
const granted = (r: ReturnType<typeof publish>) =>
  r.definition.agents[0]!.tools.map((t) => `${t.server}/${t.tool}`);

describe('publish expands a wildcard into the reviewed tools', () => {
  it('replaces the pattern by the matching tools of the approved snapshot, sorted', () => {
    const r = publish([{ server: 'logs', tool: 'get_*', allowAdditionalArgs: true }]);
    expect(r.errors).toEqual([]);
    expect(granted(r)).toEqual(['logs/get_a', 'logs/get_b']);
    expect(r.definition.wildcardExpansion?.['logs/get_*']?.tools).toEqual(['get_a', 'get_b']);
    expect(
      publish([{ server: 'logs', tool: '*', allowAdditionalArgs: true }]).definition.agents[0]!
        .tools,
    ).toHaveLength(3);
  });

  it('keeps every limit of the wildcard on each tool (a constraint can only restrict)', () => {
    const r = publish([
      {
        server: 'logs',
        tool: 'get_*',
        args: { id: { type: 'string', maxLength: 8 } },
        approval: 'required',
        maxCallsPerRun: 3,
        classification: 'internal',
      },
    ]);
    for (const t of r.definition.agents[0]!.tools) {
      expect(t.args).toEqual({ id: { type: 'string', maxLength: 8, required: false } });
      expect(t.allowAdditionalArgs).toBe(false);
      expect(t.approval).toBe('required');
      expect(t.maxCallsPerRun).toBe(3);
      expect(t.classification).toBe('internal');
    }
  });

  it('refuses a wildcard without a reviewed tool list: it is never granted silently', () => {
    for (const server of ['open', 'nowhere']) {
      const r = publish([{ server, tool: 'get_*', allowAdditionalArgs: true }]);
      expect(r.errors).toEqual([
        expect.objectContaining({ code: 'wildcard_unreviewed', path: 'agents.0.tools.0.tool' }),
      ]);
      expect(granted(r)).toEqual([]);
    }
    // a pinned connection without an approved snapshot is reported by the pin check
    const r = publish([{ server: 'unreviewed', tool: 'get_*', allowAdditionalArgs: true }]);
    expect(r.errors.map((e) => e.code)).toEqual(['mcp_tools_unreviewed']);
    expect(granted(r)).toEqual([]);
  });

  it('refuses a pattern that matches nothing', () => {
    const r = publish([{ server: 'logs', tool: 'zzz_*', allowAdditionalArgs: true }]);
    expect(r.errors.map((e) => e.code)).toEqual(['wildcard_empty']);
  });

  it('resolves overlaps as at run time: the exact grant wins, then the first wildcard', () => {
    const r = publish([
      { server: 'logs', tool: 'get_a', approval: 'required', allowAdditionalArgs: true },
      { server: 'logs', tool: 'get_*', maxCallsPerRun: 1, allowAdditionalArgs: true },
      { server: 'logs', tool: '*', allowAdditionalArgs: true },
    ]);
    const by = Object.fromEntries(r.definition.agents[0]!.tools.map((t) => [t.tool, t]));
    expect(by.get_a).toMatchObject({ approval: 'required' });
    expect(by.get_a!.maxCallsPerRun).toBeUndefined();
    expect(by.get_b).toMatchObject({ maxCallsPerRun: 1 });
    expect(by.put_c!.maxCallsPerRun).toBeUndefined();
    expect(r.definition.agents[0]!.tools).toHaveLength(3);
  });

  it('puts the expansion under the digest the review is bound to', () => {
    const digest = (tools: string[]) =>
      expandProfiles(withTools([{ server: 'logs', tool: 'get_*', allowAdditionalArgs: true }]), {
        ...CATALOG,
        logs: conn(tools),
      }).definition.expansionDigest;
    const base = digest(['get_a', 'get_b']);
    expect(digest(['get_a', 'get_b'])).toBe(base);
    // a tool added to the reviewed list changes what is granted, and therefore the digest
    expect(digest(['get_a', 'get_b', 'get_admin_token'])).not.toBe(base);
    expect(digest(['get_a'])).not.toBe(base);
  });

  it('does not match a tool the snapshot gained after publish', () => {
    const { definition } = publish([{ server: 'logs', tool: 'get_*', allowAdditionalArgs: true }]);
    const call = (tool: string) =>
      evaluateToolCall(
        { server: 'logs', tool, args: {} },
        { definition, agent: definition.agents[0]!, toolAccess: definition.toolAccess },
      ).effect;
    expect(call('get_a')).toBe('allow');
    expect(call('get_admin_token')).toBe('deny');
  });
});

// ---------------------------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------------------------

const manifestOf = (r: ReturnType<typeof exportOf>): Obj => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.findings)}`);
  return r.manifest as Obj;
};
const entryOf = (m: Obj, key = 'srv.do_it'): Obj => {
  const agents = (m.spec as Obj).agents as Obj[];
  return ((agents[0]!.permissions as Obj).tools as Obj)[key] as Obj;
};
const grantDef = (g: Obj) =>
  probe((o) => (o.agents[0]!.tools = [{ server: 'srv', tool: 'do_it', ...g }]));

/** The pinned schema as AEP-0002 would change it (a test-only copy, never vendored). */
function futureSchema(): Record<string, unknown> {
  const s = structuredClone(AWP_SCHEMA) as {
    $defs: {
      Metadata: { properties: Obj };
      Permissions: { properties: { tools: { additionalProperties: { properties: Obj } } } };
    };
  };
  s.$defs.Metadata.properties.requiredExtensions = { type: 'array', items: { type: 'string' } };
  Object.assign(s.$defs.Permissions.properties.tools.additionalProperties.properties, {
    args: { type: 'object' },
    allowAdditionalArgs: { type: 'boolean' },
    maxCalls: { type: 'integer', minimum: 1 },
  });
  return s;
}

describe('export of argument constraints', () => {
  const constrained = {
    args: { key: { type: 'string', required: true, pattern: '^SEC-\\d+$', maxLength: 32 } },
    maxCallsPerRun: 2,
  };

  it('is refused while the pin has neither the fields nor requiredExtensions (decision D3)', () => {
    const r = exportOf(grantDef(constrained));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.findings.map((f) => `${f.code}:${f.field}`).sort()).toEqual([
        'critical_extension:allowAdditionalArgs',
        'critical_extension:args',
        'critical_extension:maxCallsPerRun',
      ]);
  });

  it('writes the extensions, and lists them as required, once the pin offers requiredExtensions', () => {
    const m = manifestOf(exportOf(grantDef(constrained), { requiredExtensionsSupported: true }));
    expect(entryOf(m)).toEqual({
      allow: true,
      'x-openagentix-args': {
        key: { type: 'string', required: true, pattern: '^SEC-\\d+$', maxLength: 32 },
      },
      'x-openagentix-allowAdditionalArgs': false,
      'x-openagentix-maxCallsPerRun': 2,
    });
    expect((m.metadata as Obj).requiredExtensions).toEqual([
      'x-openagentix-allowAdditionalArgs',
      'x-openagentix-args',
      'x-openagentix-maxCallsPerRun',
    ]);
  });

  it('writes an open grant with constraints as an explicit true', () => {
    const m = manifestOf(
      exportOf(grantDef({ ...constrained, allowAdditionalArgs: true }), {
        requiredExtensionsSupported: true,
      }),
    );
    expect(entryOf(m)['x-openagentix-allowAdditionalArgs']).toBe(true);
  });

  describe('with the core fields of AEP-0002 (a pin that has them)', () => {
    const core = { toolArgsSupported: true, requiredExtensionsSupported: true } as const;

    it('writes args, allowAdditionalArgs and maxCalls and no extension', () => {
      const m = manifestOf(exportOf(grantDef(constrained), core));
      expect(entryOf(m)).toEqual({
        allow: true,
        args: { key: { type: 'string', required: true, pattern: '^SEC-\\d+$', maxLength: 32 } },
        maxCalls: 2,
      });
      expect(JSON.stringify(m)).not.toContain('x-openagentix-');
      expect((m.metadata as Obj).requiredExtensions).toBeUndefined();
    });

    it('keeps "no argument at all" with an empty args', () => {
      const m = manifestOf(exportOf(grantDef({}), core));
      expect(entryOf(m)).toEqual({ allow: true, args: {} });
    });

    it('writes nothing for a grant that allows any argument and has no limit', () => {
      const m = manifestOf(exportOf(grantDef({ allowAdditionalArgs: true }), core));
      expect(entryOf(m)).toEqual({ allow: true });
    });

    it('writes an open grant with constraints as an explicit true', () => {
      const m = manifestOf(exportOf(grantDef({ ...constrained, allowAdditionalArgs: true }), core));
      expect(entryOf(m).allowAdditionalArgs).toBe(true);
    });

    it('still carries the data class as an extension and lists it', () => {
      const m = manifestOf(
        exportOf(grantDef({ ...constrained, classification: 'internal' }), core),
      );
      expect(entryOf(m)['x-openagentix-classification']).toBe('internal');
      expect((m.metadata as Obj).requiredExtensions).toEqual(['x-openagentix-classification']);
    });

    it('passes the validator of a schema that has the fields, and the no-widening check', () => {
      const def = grantDef({ ...constrained, classification: undefined });
      const m = manifestOf(exportOf(def, core));
      const r = validateManifestSource(JSON.stringify(m), {
        layout: 'document',
        schemas: { awp: futureSchema() },
      })!;
      expect(r.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(verifyNoWidening(def, m as never, { requiredExtensions: true })).toEqual([]);
    });
  });

  it('refuses a stored constraint the validator would reject, and writes nothing', () => {
    const r = exportOf(
      grantDef({
        allowAdditionalArgs: true,
        args: {
          a: { pattern: '^x$' },
          b: { pattern: '(a)\\1', maxLength: 4 },
          c: { type: 'string', minimum: 1 },
        },
      }),
      { toolArgsSupported: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.findings.map((f) => `${f.code} ${f.path}`)).toEqual([
        'constraint_not_representable agents.0.tools.0.args.a.pattern',
        'constraint_not_representable agents.0.tools.0.args.b.pattern',
        'constraint_not_representable agents.0.tools.0.args.c',
      ]);
  });

  it('knows whether the pinned schema has the core fields (a pin upgrade must switch on purpose)', () => {
    const tools = (
      AWP_SCHEMA as unknown as {
        $defs: {
          Permissions: { properties: { tools: { additionalProperties: { properties: Obj } } } };
        };
      }
    ).$defs.Permissions.properties.tools.additionalProperties.properties;
    expect(PINNED_AWP_FEATURES.toolArgs).toBe('args' in tools);
    expect('allowAdditionalArgs' in tools).toBe(PINNED_AWP_FEATURES.toolArgs);
    expect('maxCalls' in tools).toBe(PINNED_AWP_FEATURES.toolArgs);
  });
});

// ---------------------------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------------------------

describe('validator rules for argument constraints (AEP-0002 sections 7.5.5 and 7.5.6)', () => {
  const base = () =>
    manifestOf(
      exportOf(grantDef({ allowAdditionalArgs: true, args: { k: { type: 'string' } } }), {
        requiredExtensionsSupported: true,
      }),
    );
  const permission = (m: Obj): Obj => entryOf(m);
  const run = (m: Obj, schemas?: { awp: Record<string, unknown> }) => {
    delete (m.metadata as Obj).integrity;
    // the pinned schema has no requiredExtensions: a manifest for it cannot carry the list
    if (!schemas) delete (m.metadata as Obj).requiredExtensions;
    return validateManifestSource(JSON.stringify(m), {
      layout: 'document',
      ...(schemas ? { schemas } : {}),
    })!;
  };
  const errors = (r: { findings: ManifestFinding[] }) =>
    r.findings.filter((f) => f.severity === 'error').map((f) => `${f.code} ${f.path}`);
  const P = '/spec/agents/0/permissions/tools/srv.do_it';

  it('accepts a valid constraint set', () => {
    const m = base();
    permission(m)['x-openagentix-args'] = {
      k: { type: 'string', pattern: '^[a-z]+$', maxLength: 8, deny: ['\\.\\.'] },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      l: { type: 'array', maxItems: 3 },
    };
    expect(errors(run(m))).toEqual([]);
  });

  it.each([
    [
      { pattern: '^a$' },
      `args.pattern-unbounded ${P}/x-openagentix-args/k/pattern`.replace('/pattern', '/pattern'),
    ],
    [{ pattern: '(', maxLength: 3 }, `args.pattern-invalid ${P}/x-openagentix-args/k/pattern`],
    [{ pattern: '(a)\\1', maxLength: 3 }, `args.pattern-invalid ${P}/x-openagentix-args/k/pattern`],
    [{ pattern: 'a(?=b)', maxLength: 3 }, `args.pattern-invalid ${P}/x-openagentix-args/k/pattern`],
    [
      { deny: ['ok', '^(a+)+$'], maxLength: 9 },
      `args.pattern-invalid ${P}/x-openagentix-args/k/deny/1`,
    ],
    [
      { type: 'number', pattern: '^1$', maxLength: 3 },
      `args.type-mismatch ${P}/x-openagentix-args/k`,
    ],
    [{ type: 'string', minimum: 1 }, `args.type-mismatch ${P}/x-openagentix-args/k`],
    [{ minimum: 3, maximum: 1 }, `args.range ${P}/x-openagentix-args/k`],
    [{ minLength: 3, maxLength: 1 }, `args.range ${P}/x-openagentix-args/k`],
  ])('rejects %j at the path of the member', (constraint, expected) => {
    const m = base();
    permission(m)['x-openagentix-args'] = { k: constraint };
    expect(errors(run(m))).toEqual([expected]);
  });

  it('rejects args and a call limit on an entry with allow: false', () => {
    const m = base();
    Object.assign(permission(m), { allow: false, 'x-openagentix-maxCallsPerRun': 1 });
    expect(errors(run(m)).sort()).toEqual([
      `args.with-deny ${P}/x-openagentix-args`,
      `args.with-deny ${P}/x-openagentix-maxCallsPerRun`,
    ]);
  });

  it('applies the same rules to the core fields of a schema that has them', () => {
    const m = base();
    const entry = permission(m);
    delete entry['x-openagentix-args'];
    delete entry['x-openagentix-allowAdditionalArgs'];
    delete (m.metadata as Obj).requiredExtensions;
    Object.assign(entry, {
      args: { k: { pattern: '^a$' }, j: { deny: ['(a)\\1'], maxLength: 9 } },
      maxCalls: 1,
    });
    expect(errors(run(m, { awp: futureSchema() }))).toEqual([
      `args.pattern-unbounded ${P}/args/k/pattern`,
      `args.pattern-invalid ${P}/args/j/deny/0`,
    ]);
    Object.assign(entry, { allow: false, args: {} });
    expect(errors(run(m, { awp: futureSchema() }))).toEqual([
      `args.with-deny ${P}/args`,
      `args.with-deny ${P}/maxCalls`,
    ]);
  });

  it('does not run a pattern: a hostile one is read, not evaluated', () => {
    const m = base();
    permission(m)['x-openagentix-args'] = {
      k: { pattern: `${'(a'.repeat(300)}${')'.repeat(300)}`, maxLength: 4 },
    };
    const started = Date.now();
    run(m);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops at the limit instead of checking an unbounded number of constraints', () => {
    const m = base();
    const entry = permission(m);
    delete entry['x-openagentix-args'];
    delete entry['x-openagentix-allowAdditionalArgs'];
    delete (m.metadata as Obj).requiredExtensions;
    const args: Obj = { many: { deny: Array.from({ length: 65 }, () => 'x'), maxLength: 9 } };
    for (let i = 0; i < 300; i++) args[`a${i}`] = { type: 'string', deny: ['x'], maxLength: 9 };
    entry.args = args;
    expect(errors(run(m, { awp: futureSchema() }))).toEqual([
      `args.limit ${P}/args`,
      `args.limit ${P}/args/many/deny`,
      'args.limit /spec', // more than 256 patterns in one document
    ]);
  });

  it('keeps the exported manifest valid under the pinned schema', () => {
    const m = base();
    expect(pinErrors(m, ['core', 'mcp'])).toEqual(expect.any(Array));
  });
});

// ---------------------------------------------------------------------------------------------
// No-widening check: extension values and malformed grant positions (follow-up #368 items 1 and 2)
// ---------------------------------------------------------------------------------------------

describe('verifyNoWidening compares the values of restricting extensions', () => {
  const full = {
    args: { key: { type: 'string', required: true, pattern: '^SEC-\\d+$', maxLength: 32 } },
    maxCallsPerRun: 2,
    classification: 'internal',
  };
  const def = (): PublishedDefinition =>
    probe((o) => {
      Object.assign(o.agents[0]!, { access: 'read-only', toolbox: 'git+node' });
      o.agents[0]!.tools = [{ server: 'srv', tool: 'do_it', ...full }];
      o.schemas = { T: { type: 'object' } };
      o.agents[0]!.output = { schema: { $ref: '#/schemas/T' }, onInvalid: 'fail' };
      o.agents[0]!.input = { from: ['event'] };
    });
  const options = { requiredExtensionsSupported: true } as const;
  const build = (d = def()) => {
    const r = exportOf(d, options);
    return { d, m: manifestOf(r) };
  };
  const check = (d: PublishedDefinition, m: Obj, requiredExtensions = true) =>
    verifyNoWidening(d, m as never, { requiredExtensions }).map((f) => f.path);
  const entry = (m: Obj) => entryOf(m);
  const step = (m: Obj) => (((m.spec as Obj).workflow as Obj[])[0] ?? {}) as Obj;

  it('accepts what the exporter writes', () => {
    const { d, m } = build();
    expect(check(d, m)).toEqual([]);
  });

  it('refuses a missing or changed argument constraint', () => {
    for (const mutate of [
      (e: Obj) => delete e['x-openagentix-args'],
      (e: Obj) => (e['x-openagentix-args'] = {}),
      (e: Obj) =>
        (e['x-openagentix-args'] = { key: { type: 'string', required: true, maxLength: 99 } }),
    ]) {
      const { d, m } = build();
      mutate(entry(m));
      expect(check(d, m)).toEqual(['spec.agents.0.permissions.tools.srv.do_it.args']);
    }
  });

  it('refuses a looser allowAdditionalArgs, also when it is missing', () => {
    for (const mutate of [
      (e: Obj) => (e['x-openagentix-allowAdditionalArgs'] = true),
      (e: Obj) => delete e['x-openagentix-allowAdditionalArgs'],
      (e: Obj) => (e.allowAdditionalArgs = true),
    ]) {
      const { d, m } = build();
      mutate(entry(m));
      expect(check(d, m)).toEqual([
        'spec.agents.0.permissions.tools.srv.do_it.allowAdditionalArgs',
      ]);
    }
  });

  it('refuses a missing, higher or malformed call limit but accepts a lower one', () => {
    for (const value of [3, 0, 1.5, '2', undefined]) {
      const { d, m } = build();
      if (value === undefined) delete entry(m)['x-openagentix-maxCallsPerRun'];
      else entry(m)['x-openagentix-maxCallsPerRun'] = value;
      expect(check(d, m), String(value)).toEqual([
        'spec.agents.0.permissions.tools.srv.do_it.maxCalls',
      ]);
    }
    const { d, m } = build();
    entry(m)['x-openagentix-maxCallsPerRun'] = 1;
    expect(check(d, m)).toEqual([]);
  });

  it('takes the stricter of the core call limit and the extension', () => {
    const { d, m } = build();
    entry(m).maxCalls = 9;
    entry(m)['x-openagentix-maxCallsPerRun'] = 2;
    expect(check(d, m)).toEqual([]);
    entry(m)['x-openagentix-maxCallsPerRun'] = 5;
    entry(m).maxCalls = 7;
    expect(check(d, m)).toEqual(['spec.agents.0.permissions.tools.srv.do_it.maxCalls']);
  });

  it('refuses a missing or changed data class', () => {
    const { d, m } = build();
    entry(m)['x-openagentix-classification'] = 'public';
    expect(check(d, m)).toEqual([
      'spec.agents.0.permissions.tools.srv.do_it.x-openagentix-classification',
    ]);
  });

  it('refuses a granted tool whose permission entry, and with it every limit, is missing', () => {
    const { d, m } = build();
    delete (((m.spec as Obj).agents as Obj[])[0]!.permissions as { tools: Obj }).tools['srv.do_it'];
    expect(check(d, m)).toEqual(['spec.agents.0.permissions.tools.srv.do_it']);
  });

  it('accepts the core form of the same limits', () => {
    const d = def();
    const m = manifestOf(
      exportOf(d, { toolArgsSupported: true, requiredExtensionsSupported: true }),
    );
    expect(check(d, m)).toEqual([]);
    entry(m).args = {};
    expect(check(d, m)).toEqual(['spec.agents.0.permissions.tools.srv.do_it.args']);
  });

  it('refuses an argument constraint given in both forms', () => {
    const { d, m } = build();
    entry(m).args = entry(m)['x-openagentix-args'] as never;
    expect(check(d, m)).toEqual(
      expect.arrayContaining(['spec.agents.0.permissions.tools.srv.do_it.args']),
    );
  });

  it('refuses a dropped access class, input, output, schemas or runtime', () => {
    const cases: [string, (m: Obj) => void, string][] = [
      [
        'access',
        (m) => delete step(m)['x-openagentix-access'],
        'spec.workflow.0.x-openagentix-access',
      ],
      [
        'input',
        (m) => delete step(m)['x-openagentix-input'],
        'spec.workflow.0.x-openagentix-input',
      ],
      [
        'output',
        (m) => (step(m)['x-openagentix-output'] = {}),
        'spec.workflow.0.x-openagentix-output',
      ],
      [
        'schemas',
        (m) => delete (m.spec as Obj)['x-openagentix-schemas'],
        'spec.x-openagentix-schemas',
      ],
      [
        'runtime',
        (m) =>
          (((m.spec as Obj).agents as Obj[])[0]!['x-openagentix-runtime'] = { toolbox: 'other' }),
        'spec.agents.0.x-openagentix-runtime.toolbox',
      ],
    ];
    for (const [name, mutate, path] of cases) {
      const { d, m } = build();
      mutate(m);
      expect(check(d, m), name).toEqual([path]);
    }
  });

  it('requires critical extensions in requiredExtensions when the pin has the list', () => {
    const { d, m } = build();
    const meta = m.metadata as Obj;
    const list = (meta.requiredExtensions as string[]).filter((n) => n !== 'x-openagentix-args');
    meta.requiredExtensions = list;
    expect(check(d, m)).toEqual(['metadata.requiredExtensions']);
    delete meta.requiredExtensions;
    expect(check(d, m, true)).toEqual(['metadata.requiredExtensions']);
    // without the list in the pin, an absent list is not a finding
    expect(check(d, m, false)).toEqual([]);
    // a list that is not a list
    meta.requiredExtensions = 'x-openagentix-args';
    expect(check(d, m, false)).toEqual(['metadata.requiredExtensions']);
  });
});

describe('verifyNoWidening refuses malformed values at grant positions', () => {
  const d = () => probe();
  const manifest = () => manifestOf(exportOf(d(), { toolArgsSupported: true }));
  const agent = (m: Obj) => ((m.spec as Obj).agents as Obj[])[0]!;
  const permissions = (m: Obj) => agent(m).permissions as Obj;
  const paths = (m: Obj) => verifyNoWidening(d(), m as never).map((f) => f.path);

  it('refuses permissions.tools that is not an object', () => {
    for (const value of [[{ allow: true }], 'srv.do_it', 5, null]) {
      const m = manifest();
      permissions(m).tools = value;
      expect(paths(m), JSON.stringify(value)).toContain('spec.agents.0.permissions.tools');
    }
  });

  it('refuses secrets and allowHosts that are not lists', () => {
    const m = manifest();
    permissions(m).secrets = 'token';
    permissions(m).network = { egress: 'deny', allowHosts: 'evil.example' };
    expect(paths(m)).toEqual([
      'spec.agents.0.permissions.network.allowHosts',
      'spec.agents.0.permissions.secrets',
    ]);
  });

  it('refuses tools of a source and requiredFor that are not lists', () => {
    const m = manifest();
    ((agent(m).tools as Obj[])[0] as Obj).tools = 'do_it';
    (m.spec as Obj).approval = { requiredFor: 'srv.do_it' };
    expect(paths(m)).toEqual(expect.arrayContaining(['spec.approval.requiredFor']));
    expect(paths(m)).toEqual(expect.arrayContaining(['spec.agents.0.tools.0.tools']));
  });

  it('refuses allow and allowAdditionalArgs that are not booleans', () => {
    for (const [field, value] of [
      ['allow', 'true'],
      ['allow', 1],
      ['allowAdditionalArgs', 'yes'],
      ['x-openagentix-allowAdditionalArgs', 0],
    ] as const) {
      const m = manifest();
      const entry = (permissions(m).tools as Obj)['srv.do_it'] as Obj;
      entry[field] = value;
      expect(paths(m), `${field}=${String(value)}`).toContain(
        `spec.agents.0.permissions.tools.srv.do_it.${field}`,
      );
    }
  });

  it('refuses a step of another type, and any step that names an agent the source lacks', () => {
    const m = manifest();
    const steps = (m.spec as Obj).workflow as Obj[];
    steps.push({ id: 'x', type: 'approval', agent: 'ghost' });
    expect(paths(m)).toEqual(['spec.workflow.1.type', 'spec.workflow.1']);
    steps[1] = { id: 'x', type: 'agent', agent: 'ghost' };
    expect(paths(m)).toEqual(['spec.workflow.1']);
  });
});

// ---------------------------------------------------------------------------------------------
// Linear-time matching, bounds and budgets (security review of the first version)
// ---------------------------------------------------------------------------------------------

describe('patterns cannot block the process', () => {
  const timed = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  // Accepted by every static rule (no nested repetition, no alternation) and still exponential or
  // high-polynomial in a backtracking engine: 17 s, more than 60 s and more than 30 s there.
  const HOSTILE: [string, string, string[]][] = [
    ['[a-z]*[a-z]*!', 'a'.repeat(4000), ['arg_pattern']],
    ['\\d*\\d*\\d*x', '1'.repeat(1000), ['arg_pattern']],
    ['\\s*\\s*\\s*$', ' '.repeat(16384), []],
  ];

  it.each(HOSTILE)(
    'static rules accept %s, matching takes under 100 ms',
    (pattern, text, expected) => {
      expect(checkRegexSource(pattern)).toBeNull();
      let reasons: string[] = [];
      const ms = timed(() => {
        reasons = checkArg('k', text, { required: false, pattern, maxLength: 100_000 }).map(
          (r) => r.code,
        );
      });
      expect(ms).toBeLessThan(100);
      expect(reasons).toEqual(expected);
    },
  );

  it.each(HOSTILE)('deny %s over many large strings is bounded', (pattern, text) => {
    const value = Array.from({ length: 4000 }, () => text);
    let codes: string[] = [];
    const ms = timed(() => {
      codes = checkArg('k', value, { required: false, deny: [pattern, pattern, pattern] }).map(
        (r) => r.code,
      );
    });
    expect(ms).toBeLessThan(1000);
    expect(codes).toEqual(['arg_denied']); // the work budget is exceeded: fail closed
  });

  it('a decision that scans more than the work budget is denied, not slowed down', () => {
    const big = 'a'.repeat(REGEX_INPUT_LIMIT);
    const value = Array.from({ length: 300 }, () => big);
    const reasons = checkArg('k', value, { required: false, deny: ['zzz'] });
    expect(reasons.map((r) => r.code)).toEqual(['arg_denied']);
    expect(reasons[0]!.message).toMatch(/cannot be checked/);
    expect(checkArg('k', ['ab', 'cd'], { required: false, deny: ['zzz'] })).toEqual([]);
  });

  it('refuses a pattern the linear-time engine cannot take, and denies at run time', () => {
    expect(checkRegexSource('\\1')?.code).toBeDefined();
    // a stored constraint with a backreference is not run in a backtracking engine
    const reasons = checkArg('k', 'aa', { required: false, pattern: '(a)\\1', maxLength: 5 });
    expect(reasons.map((r) => r.code)).toEqual(['arg_pattern']);
    expect(reasons[0]!.message).toMatch(/cannot be checked/);
  });

  it('does not repeat the pattern or the value in a reason', () => {
    const reasons = [
      ...checkArg('k', 'SECRET-VALUE', { required: false, pattern: '^SECRET-PAT$', maxLength: 50 }),
      ...checkArg('k', 'SECRET-VALUE', { required: false, deny: ['SECRET-DENY'], maxLength: 50 }),
      ...checkArg('k', 'SECRET-DENY', { required: false, deny: ['SECRET-DENY'], maxLength: 50 }),
    ];
    expect(reasons.map((r) => r.code)).toEqual(['arg_pattern', 'arg_denied']);
    expect(JSON.stringify(reasons)).not.toMatch(/SECRET/);
  });
});

describe('static caps of pattern and deny', () => {
  const codes = (c: Obj) => argConstraintIssues(c).map((i) => `${i.code}@${i.field}`);
  it('bounds the matched text to 4096 and requires a bound for deny', () => {
    expect(codes({ pattern: '^a$', maxLength: 4096 })).toEqual([]);
    expect(codes({ pattern: '^a$', maxLength: 4097 })).toEqual(['args.pattern-unbounded@pattern']);
    expect(codes({ deny: ['x'] })).toEqual(['args.pattern-unbounded@deny']);
    expect(codes({ deny: ['x'], maxLength: 99999 })).toEqual(['args.pattern-unbounded@deny']);
    expect(codes({ deny: ['x'], maxLength: 10 })).toEqual([]);
  });
  it('allows at most 64 deny patterns', () => {
    const deny = Array.from({ length: 65 }, () => 'x');
    expect(codes({ deny, maxLength: 10 })).toEqual(['args.limit@deny']);
    expect(codes({ deny: deny.slice(1), maxLength: 10 })).toEqual([]);
  });
});

describe('policy-wide forbidden patterns', () => {
  const bundle = (pattern: string) => ({
    forbiddenTools: [],
    forbiddenArgPatterns: [{ pattern, reason: 'no' }],
    requireApprovalTools: [],
  });
  const run = (args: unknown, pattern = 'rm\\s+-rf') =>
    evaluateToolCall(
      { server: 's', tool: 't', args: args as Record<string, unknown> },
      {
        definition: { classification: 'internal' },
        agent: { id: 'a', tools: [grant({ server: 's', tool: 't', allowAdditionalArgs: true })] },
        bundles: [bundle(pattern)],
      },
    );

  it('matches case-insensitively and denies a hit', () => {
    expect(run({ x: 'please RM  -rf /' }).effect).toBe('deny');
    expect(run({ x: 'fine' }).effect).toBe('allow');
  });
  it('denies a value too deep or too long to inspect instead of letting it pass', () => {
    let deep: unknown = 'rm -rf';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(run({ x: deep }).effect).toBe('deny');
    expect(run({ x: 'a'.repeat(REGEX_INPUT_LIMIT + 1) }).effect).toBe('deny');
  });
  it('denies when the pattern cannot run, and stays fast on a hostile one', () => {
    expect(run({ x: 'aa' }, '(a)\\1').effect).toBe('deny');
    const t0 = performance.now();
    expect(run({ x: 'a'.repeat(4000) }, '[a-z]*[a-z]*!').effect).toBe('allow');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('reasons carry no caller text', () => {
  it('does not repeat the name of an undeclared argument', () => {
    const name = 'sk-live-0123456789abcdef-SECRET';
    const d = decide({ server: 's', tool: 't', args: { ok: { type: 'string' } } }, { [name]: 'v' });
    expect(d.reasons.map((r) => r.code)).toEqual(['arg_unknown']);
    expect(JSON.stringify(d.reasons)).not.toContain('SECRET');
  });
});

describe('agents.md warnings', () => {
  it('warns about an unanchored pattern and not about an anchored one', () => {
    const w = (p: string) =>
      validateAgentSource(
        fm(`{ server: s, tool: t, args: { k: { pattern: "${p}", maxLength: 9 } } }`),
      ).warnings.map((x) => x.message);
    expect(w('SEC-1').join()).toMatch(/not anchored.*substring/);
    expect(w('^SEC-1').join()).toMatch(/not anchored/);
    expect(w('SEC-1$').join()).toMatch(/not anchored/);
    expect(w('^SEC-[0-9]+$').join()).not.toMatch(/not anchored/);
  });
  it('warns when a profile grant can override the limits of a prefix wildcard', () => {
    const src = fm('{ server: s, tool: "get_*", args: { k: { type: string } } }').replace(
      '      - { server',
      '      - { server: s, profile: read }\n      - { server',
    );
    const r = validateAgentSource(src);
    expect(r.warnings.map((x) => x.message).join('\n')).toMatch(/profile grant gives exact grants/);
  });
});

// ---------------------------------------------------------------------------------------------
// Program size, repeat bounds and the semantics contract (second security review)
// ---------------------------------------------------------------------------------------------

describe('programs of bounded size', () => {
  // Linear in the input but not in the program: these took 0.4 s, 10 s, 24 s and 96 s for one test().
  const BIG: [string, string][] = [
    ['.{0,1000}x', 'a'.repeat(4096)],
    [`${'[^x]{0,999}'.repeat(10)}x`, 'a'.repeat(4096)],
    [`${'.{0,999}'.repeat(20)}x`, 'a'.repeat(4096)],
    [`${'[^x]{0,999}'.repeat(90)}x`, 'a'.repeat(4096)],
  ];

  it.each(BIG)('refuses %#: at validation and at run time, in under 100 ms', (pattern, text) => {
    expect(['too-large', 'too-long']).toContain(checkRegexSource(pattern)?.code);
    expect(compileLinear(pattern)).toBeNull();
    const started = performance.now();
    // a stored constraint of an older version: never compiled, never run
    expect(
      checkArg('k', text, { required: false, pattern, maxLength: 5000 }).map((r) => r.code),
    ).toEqual(['arg_pattern']);
    expect(
      checkArg('k', [text, text], { required: false, deny: [pattern] }).map((r) => r.code),
    ).toEqual(['arg_denied']);
    const huge = 'a'.repeat(REGEX_INPUT_LIMIT);
    const d = evaluateToolCall(
      { server: 's', tool: 't', args: { x: huge } },
      {
        definition: { classification: 'internal' },
        agent: { id: 'a', tools: [grant({ server: 's', tool: 't', allowAdditionalArgs: true })] },
        bundles: [
          {
            forbiddenTools: [],
            forbiddenArgPatterns: [{ pattern, reason: 'no' }],
            requireApprovalTools: [],
          },
        ],
      },
    );
    expect(d.effect).toBe('deny');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('limits one repeat to 200, the sum of repeats to 400 and the program to 512 instructions', () => {
    expect(checkRegexSource('^[a-z]{0,200}$')).toBeNull();
    expect(checkRegexSource('^[a-z]{0,201}$')?.code).toBe('too-large');
    expect(checkRegexSource('^[a-z]{201,}$')?.code).toBe('too-large');
    expect(checkRegexSource('^a{100}b{100}c{100}d{100}$')).toBeNull();
    expect(checkRegexSource('^a{100}b{100}c{100}d{100}e{1}$')?.code).toBe('too-large');
    // a long flat pattern with no repeat at all is a long program
    expect(checkRegexSource('^(ab){100}(cd){100}(ef){100}(gh){100}$')?.code).toBe('unsupported');
    expect(compileLinear('^(src|test)/[A-Za-z0-9._/-]{1,200}$')?.size).toBeLessThan(512);
  });

  it('does not count a brace in a class or an escape as a repeat', () => {
    expect(checkRegexSource('^[{9999}]$')).toBeNull();
    expect(checkRegexSource('^\\{9999\\}$')).toBeNull();
  });

  it('charges the work budget in steps (length x program size), so time stays bounded', () => {
    const re = compileLinear('^[a-z]{200}$')!;
    expect(re.size).toBeGreaterThan(150);
    const strings = Array.from({ length: 5 }, () => 'a'.repeat(REGEX_INPUT_LIMIT));
    // 5 x 16384 x ~200 steps is above the budget although the character count is small
    expect(5 * REGEX_INPUT_LIMIT * re.size).toBeGreaterThan(REGEX_WORK_BUDGET);
    const t0 = performance.now();
    const reasons = checkArg('k', strings, { required: false, deny: ['^[a-z]{200}$'] });
    expect(reasons.map((r) => r.code)).toEqual(['arg_denied']);
    expect(reasons[0]!.message).toMatch(/cannot be checked/);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(checkArg('k', ['abc'], { required: false, deny: ['^[a-z]{200}$'] })).toEqual([]);
  });

  it('charges steps for a pattern and for a policy pattern, not only characters', () => {
    const wide = '[a-z]{0,200}Q'; // about 400 instructions, never matches 'a...a'
    const text = 'a'.repeat(REGEX_INPUT_LIMIT);
    const size = compileLinear(wide)!.size;
    expect(2 * REGEX_INPUT_LIMIT * size).toBeGreaterThan(REGEX_WORK_BUDGET);
    expect(REGEX_INPUT_LIMIT * size).toBeLessThan(REGEX_WORK_BUDGET);
    const c = { required: false, pattern: wide, maxLength: 100_000 };
    const run = (bundles: unknown[], args: Obj, g: Obj) =>
      evaluateToolCall(
        { server: 's', tool: 't', args },
        {
          definition: { classification: 'internal' },
          agent: { id: 'a', tools: [grant({ server: 's', tool: 't', ...g })] },
          bundles: bundles as never,
        },
      );
    // two arguments, one pattern each: the second runs out of budget and denies as "cannot be checked"
    const d = run(
      [],
      { a: text, b: text },
      {
        args: {
          a: { ...c, pattern: `${wide.slice(0, -1)}` },
          b: { ...c, pattern: `${wide.slice(0, -1)}` },
        },
      },
    );
    expect(d.reasons.map((r) => r.message).join()).toMatch(
      /b.*cannot be checked against its pattern/,
    );
    // two policy patterns over one large argument
    const bundle = (p: string) => ({
      forbiddenTools: [],
      forbiddenArgPatterns: [{ pattern: p, reason: 'no' }],
      requireApprovalTools: [],
    });
    const e = run([bundle(wide), bundle(wide)], { x: text }, { allowAdditionalArgs: true });
    expect(e.effect).toBe('deny');
    expect(e.reasons.map((r) => r.message).join()).toMatch(
      /cannot be checked against a policy pattern/,
    );
    expect(run([bundle(wide)], { x: text }, { allowAdditionalArgs: true }).effect).toBe('allow');
  });

  it('allows at most 128 pattern and deny expressions in one definition', () => {
    const args = (n: number, from: number) =>
      Array.from(
        { length: n },
        (_, i) => `k${from + i}: { type: string, maxLength: 9, deny: ["x"] }`,
      ).join(', ');
    const src = (n: number) => fm(`{ server: s, tool: t, args: { ${args(n, 0)} } }`);
    expect(validateAgentSource(src(128)).errors).toEqual([]);
    expect(validateAgentSource(src(129)).errors.map((e) => e.message)).toEqual([
      'pattern and deny expressions of one definition: at most 128 patterns are allowed here',
    ]);
  });
});

describe('the matcher contract is RE2, not ECMA-262', () => {
  const test = (p: string, text: string) => compileLinear(p, false, false)!.test(text);

  it('"." matches CR, so ^a.b$ accepts a carriage return', () => {
    expect(test('^a.b$', 'a\rb')).toBe(true);
    expect(test('^a.b$', 'a\nb')).toBe(false);
    expect(test('^a[^\\r\\n]b$', 'a\rb')).toBe(false);
  });

  it('"\\s" does not match a no-break space or a vertical tab', () => {
    expect(test('^a\\sb$', 'a\u00a0b')).toBe(false);
    expect(test('^a\\sb$', 'a\u000bb')).toBe(false);
    expect(test('^a[ \\t\\r\\n\\f\\x0b\\xa0]b$', 'a\u00a0b')).toBe(true);
    expect(test('^a[ \\t\\r\\n\\f\\x0b\\xa0]b$', 'a\u000bb')).toBe(true);
  });

  it('accepts the documented spelled-out class, in validation and at run time', () => {
    const nbsp = 'rm[ \\t\\r\\n\\f\\x0b\\xa0]+-rf';
    expect(checkRegexSource(nbsp)).toBeNull();
    expect(test(nbsp, 'rm\u00a0-rf')).toBe(true);
    expect(test(nbsp, 'rm\u000b-rf')).toBe(true);
    expect(test('rm\\s+-rf', 'rm\u00a0-rf')).toBe(false);
  });

  it('refuses ECMA-262 constructs RE2 does not have (fail closed)', () => {
    for (const p of ['\\u0041', '\\u{41}', '\\p{Script=Greek}', '[^]', '(?<n>a)\\k<n>'])
      expect(compileLinear(p, false, false), p).toBeNull();
  });

  it('keeps "." and "\\s" out of deny patterns and warns about "." in a pattern', () => {
    expect(usesDotOrSpaceClass('rm\\s+-rf')).toBe(true);
    expect(usesDotOrSpaceClass('a.b')).toBe(true);
    expect(usesDotOrSpaceClass('[\\s]')).toBe(true);
    expect(usesDotOrSpaceClass('\\.\\.')).toBe(false);
    expect(usesDotOrSpaceClass('[.-]')).toBe(false);
    expect(usesDotOrSpaceClass('^[/~]')).toBe(false);
    expect(
      argConstraintIssues({ deny: ['rm\\s+-rf', 'a.b', '\\.\\.'], maxLength: 9 }).map(
        (i) => `${i.code}@${i.field}`,
      ),
    ).toEqual(['args.pattern-invalid@deny.0', 'args.pattern-invalid@deny.1']);
    const w = validateAgentSource(
      fm('{ server: s, tool: t, args: { k: { pattern: "^a.b$", maxLength: 9 } } }'),
    ).warnings.map((x) => x.message);
    expect(w.join()).toMatch(/RE2 semantics/);
  });
});

// ---------------------------------------------------------------------------------------------
// Compile cost: bounded by the source that is written (third security review)
// ---------------------------------------------------------------------------------------------

describe('compile cost is bounded by source size', () => {
  // About 11 instructions per 23 characters, unique suffix so that nothing is shared or cached.
  const slow = (i: number, chars = 250): string => {
    const unit = '[\\p{L}\\p{N}\\p{P}\\p{S}]';
    return (
      unit.repeat(Math.max(0, Math.floor((chars - 12) / unit.length))) +
      `u${String(i).padStart(10, '0')}`
    );
  };
  const timed = <T>(fn: () => T): [T, number] => {
    const t0 = performance.now();
    const out = fn();
    return [out, performance.now() - t0];
  };

  it('refuses a pattern source above 256 characters, at validation and at run time', () => {
    expect(checkRegexSource(slow(1, 256))).toBeNull();
    expect(checkRegexSource(slow(1, 880))?.code).toBe('too-long');
    expect(compileLinear(slow(1, 880))).toBeNull();
    expect(compileLinear(slow(1, 250))).not.toBeNull();
  });

  it('caps the patterns of a set by count and by total characters', () => {
    const many = (n: number, chars: number) => Array.from({ length: n }, (_, i) => slow(i, chars));
    expect(checkPatternList(many(64, 128), 64)).toBeNull(); // 8192 characters
    expect(checkPatternList(many(65, 8), 64)?.message).toMatch(/at most 64/);
    expect(checkPatternList(many(40, 250), 64)?.message).toMatch(/together.*8192/);
    expect(MAX_PATTERN_CHARS).toBe(8192);
  });

  it('validates a definition at the limit in under 1 s, and one above it without compiling', () => {
    const arg = (k: number, n: number, chars: number) =>
      `k${k}: { type: string, maxLength: 9, deny: [${Array.from({ length: n }, (_, i) => JSON.stringify(slow(k * 100 + i, chars))).join(', ')}] }`;
    // 32 x 250 = 8000 characters: accepted and compiled by validation
    const ok = fm(`{ server: s, tool: t, args: { ${arg(0, 32, 250)} } }`);
    const [r, ms] = timed(() => validateAgentSource(ok));
    expect(
      r.errors.map((e) => e.message).filter((m) => !/deny patterns must not use/.test(m)),
    ).toEqual([]);
    expect(ms).toBeLessThan(1000);
    // 40 x 250 = 10000 characters: refused up front, nothing is compiled
    const over = fm(`{ server: s, tool: t, args: { ${arg(0, 40, 250)} } }`);
    const [r2, ms2] = timed(() => validateAgentSource(over));
    expect(r2.errors.map((e) => e.message).join()).toMatch(/together.*8192/);
    expect(ms2).toBeLessThan(200);
  });

  it('does not fill the compile cache while validating', () => {
    resetLinearCache();
    const p = slow(999, 120);
    expect(checkRegexSource(p)).toBeNull();
    expect(isCachedLinear(p)).toBe(false);
    expect(compileLinear(p)).not.toBeNull();
    expect(isCachedLinear(p)).toBe(true);
  });

  it('limits the characters of patterns in one AWP manifest too, not only their count', () => {
    const deny = Array.from({ length: 40 }, (_, i) => slow(i, 250)); // 40 x 231 > 8192, count is fine
    const m = manifestOf(
      exportOf(
        probe((o) => {
          o.agents[0]!.tools = [
            {
              server: 'srv',
              tool: 'do_it',
              allowAdditionalArgs: true,
              args: { k: { type: 'string', maxLength: 9, deny } },
            },
          ];
        }),
        { requiredExtensionsSupported: true },
      ),
    );
    delete (m.metadata as Obj).requiredExtensions;
    delete (m.metadata as Obj).integrity;
    const r = validateManifestSource(JSON.stringify(m), { layout: 'document' })!;
    expect(r.findings.map((f) => `${f.code} ${f.path}`)).toContain('args.limit /spec');
  });

  it('decides with 32 cold slow-compiling deny patterns in under 1 s', () => {
    resetLinearCache();
    const deny = Array.from({ length: 32 }, (_, i) => slow(i, 250));
    const [reasons, ms] = timed(() => checkArg('k', 'hello', { required: false, deny }));
    expect(reasons).toEqual([]);
    expect(ms).toBeLessThan(1000);
    // the compile is charged to the budget: the same set twice more is still within it
    resetLinearCache();
    const [again, ms2] = timed(() => checkArg('k', 'hello', { required: false, deny }));
    expect(again).toEqual([]);
    expect(ms2).toBeLessThan(1000);
  });

  it('charges cold compiles to the budget, so a decision with too many is denied', () => {
    resetLinearCache();
    const patterns = Array.from({ length: 64 }, (_, i) => slow(i, 128));
    const bundle = (k: number) => ({
      forbiddenTools: [],
      forbiddenArgPatterns: patterns
        .slice(0, 64)
        .map((p) => ({ pattern: `${p}${k}`, reason: 'no' })),
      requireApprovalTools: [],
    });
    // 8 bundles x 64 cold patterns x 130 characters x 400 steps is far above 10,000,000
    const t0 = performance.now();
    const d = evaluateToolCall(
      { server: 's', tool: 't', args: { x: 'hello' } },
      {
        definition: { classification: 'internal' },
        agent: { id: 'a', tools: [grant({ server: 's', tool: 't', allowAdditionalArgs: true })] },
        bundles: Array.from({ length: 8 }, (_, k) => bundle(k)),
      },
    );
    expect(d.effect).toBe('deny');
    expect(d.reasons.map((r) => r.message).join()).toMatch(
      /cannot be checked against a policy pattern/,
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('refuses stored data above the limits without compiling anything', () => {
    resetLinearCache();
    const huge = Array.from({ length: 300 }, (_, i) => slow(i, 250));
    const t0 = performance.now();
    const policy = evaluateToolCall(
      { server: 's', tool: 't', args: { x: 'hello' } },
      {
        definition: { classification: 'internal' },
        agent: { id: 'a', tools: [grant({ server: 's', tool: 't', allowAdditionalArgs: true })] },
        bundles: [
          {
            forbiddenTools: [],
            forbiddenArgPatterns: huge.map((pattern) => ({ pattern, reason: 'no' })),
            requireApprovalTools: [],
          },
        ],
      },
    );
    expect(policy.effect).toBe('deny');
    expect(policy.reasons.map((r) => r.message).join()).toMatch(/pattern limits of a policy/);
    const stored = decide(
      { server: 's', tool: 't', args: { k: { type: 'string', deny: huge } } },
      { k: 'hello' },
    );
    expect(stored.reasons.map((r) => r.message).join()).toMatch(/pattern limits of this grant/);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(compileLinear(huge[0]!, false, true)).not.toBeNull(); // nothing was cached before this line
  });
});

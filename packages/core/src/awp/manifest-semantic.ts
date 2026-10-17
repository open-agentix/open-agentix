import { createHash } from 'node:crypto';
import { jcs } from '../jcs.js';
import type {
  AwpAgentSpec,
  AwpInlineAgent,
  AwpMetadata,
  AwpPermissions,
  AwpPolicySpec,
  AwpStep,
  AwpToolSource,
  AwpWorkflowSpec,
} from './generated/awp-types.js';
import type { ManifestFinding } from './manifest-types.js';

/**
 * Semantic rules of AWP v1alpha1 that JSON Schema cannot express (rule catalogue:
 * `packages/awp/vendor/awp-v1alpha1/schema/README.md`). This is OpenAgentix's own implementation of
 * the pinned rules: same codes, same JSON Pointer paths. `packages/core/test/awp-semantic-diff.test.ts`
 * runs it against the vendored reference (`conformance/semantic.mjs`) on the whole conformance suite
 * and on mutated documents, so a deviation fails a test.
 *
 * Input: a document that already passed the structural schema (the shapes below are what the schema
 * guarantees). Nothing here executes or fetches anything.
 */

const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'token',
  'password',
  'apiKey',
  'secret',
  'privateKey',
]);
const DIGEST_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;
const PINNED_IMAGE = /@(sha256:[0-9a-f]{64}|sha384:[0-9a-f]{96}|sha512:[0-9a-f]{128})$/;
/** Metadata members that the digest does not cover (spec 9.1). */
const DIGEST_EXCLUDED = ['integrity', 'signature', 'provenance'] as const;

const esc = (s: string | number): string => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
/** RFC 6901 JSON Pointer from path parts. */
export const pointer = (...parts: (string | number)[]): string =>
  parts.map((p) => `/${esc(p)}`).join('');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Digest of a manifest with the given algorithm (spec 9.1); throws `JcsError` outside the JSON model. */
export function manifestDigestWith(doc: Obj, algorithm: string): string {
  const copy: Obj = { ...doc };
  if (isObj(copy.metadata)) {
    const metadata: Obj = { ...copy.metadata };
    for (const key of DIGEST_EXCLUDED) delete metadata[key];
    copy.metadata = metadata;
  }
  return `${algorithm}:${createHash(algorithm).update(jcs(copy), 'utf8').digest('hex')}`;
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Visits every node outside `x-` subtrees (extension subtrees are opaque to the AWP rules, spec 3.3). */
function forEachNode(root: unknown, fn: (node: unknown, path: (string | number)[]) => void): void {
  const todo: { node: unknown; path: (string | number)[] }[] = [{ node: root, path: [] }];
  while (todo.length > 0) {
    const { node, path } = todo.pop()!;
    fn(node, path);
    // Children are pushed in reverse so that they are visited in document order (pre-order).
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) todo.push({ node: node[i], path: [...path, i] });
    } else if (isObj(node)) {
      const entries = Object.entries(node);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        if (!k.startsWith('x-')) todo.push({ node: v, path: [...path, k] });
      }
    }
  }
}

export interface SemanticOptions {
  profiles: ReadonlySet<string>;
  verifyDigest: boolean;
  /** Stop collecting after this many findings (a hostile document must not cost more than that). */
  maxFindings?: number;
}

interface Doc extends Obj {
  kind?: string;
  metadata?: AwpMetadata;
  spec?: unknown;
}

/**
 * Semantic findings of a structurally valid document, in the order of the reference implementation.
 */
export function semanticFindings(doc: Doc, opts: SemanticOptions): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const { profiles } = opts;
  const cap = opts.maxFindings ?? Number.POSITIVE_INFINITY;
  const add = (
    severity: ManifestFinding['severity'],
    code: string,
    section: string,
    path: string,
    message: string,
  ): void => {
    if (out.length < cap) out.push({ severity, code, message, path, section });
  };
  const err = (code: string, section: string, path: string, message: string): void =>
    add('error', code, section, path, message);
  const warn = (code: string, section: string, path: string, message: string): void =>
    add('warning', code, section, path, message);
  const needProfile = (profile: string, field: string, path: string, section: string): void => {
    if (!profiles.has(profile)) {
      err(
        'profile.unsupported',
        section,
        path,
        `field ${field} belongs to the "${profile}" profile, which is not supported`,
      );
    }
  };

  const kind = doc.kind;
  const meta: Partial<AwpMetadata> = doc.metadata ?? {};
  const spec = (doc.spec ?? {}) as Obj;

  // 3.8 / 9.1: digest algorithm and verification
  forEachNode(doc, (n, p) => {
    if (isObj(n) && typeof n.digest === 'string') {
      const alg = n.digest.split(':')[0] ?? '';
      if (!(DIGEST_ALGORITHMS as readonly string[]).includes(alg)) {
        warn(
          'digest.algorithm-unknown',
          '3.8',
          pointer(...p, 'digest'),
          `digest algorithm "${alg}" is not one of sha256, sha384, sha512; verification is impossible where required`,
        );
      }
    }
  });
  if (opts.verifyDigest && meta.integrity?.digest) {
    const declared = meta.integrity.digest;
    const alg = declared.split(':')[0] ?? '';
    if (!(DIGEST_ALGORITHMS as readonly string[]).includes(alg)) {
      err(
        'digest.unsupported-algorithm',
        '9.1',
        '/metadata/integrity/digest',
        `cannot verify digest algorithm "${alg}"`,
      );
    } else {
      const expected = manifestDigestWith(doc, alg);
      if (expected !== declared) {
        err(
          'digest.mismatch',
          '9.1',
          '/metadata/integrity/digest',
          `metadata.integrity.digest does not match the manifest (computed ${expected})`,
        );
      }
    }
  }

  // 7.9: literal credential fields anywhere outside x- extensions
  forEachNode(doc, (n, p) => {
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (SECRET_FIELD_NAMES.has(k) && v !== null && typeof v !== 'object') {
        err(
          'secret.literal-field',
          '7.9',
          pointer(...p, k),
          `field "${k}" with a literal value; secrets MUST NOT appear in manifests, use secretRef`,
        );
      }
    }
  });

  const checkDate = (s: unknown, path: string): void => {
    if (typeof s === 'string' && !validDate(s))
      err('date.invalid', '3.7', path, `"${s}" is not a valid calendar date`);
  };

  // 3.3: profile-bound fields
  if (meta.risk && ['high', 'critical'].includes(meta.risk.level)) {
    needProfile(
      'governance',
      `metadata.risk.level: ${meta.risk.level}`,
      '/metadata/risk/level',
      '3.3',
    );
  }
  if (meta.signature) needProfile('security', 'metadata.signature', '/metadata/signature', '3.3');
  if (kind === 'Policy') needProfile('governance', 'kind: Policy', '/kind', '3.3');

  // 7.1: governance profile requirements
  if (
    profiles.has('governance') &&
    (kind === 'Workflow' || kind === 'Agent') &&
    meta.classification === undefined
  ) {
    err(
      'governance.classification-required',
      '7.1',
      '/metadata',
      'metadata.classification is REQUIRED for Workflow and Agent under the governance profile',
    );
  }

  type SecretDecl = { name: string; scope?: string[] };
  const secretsDecl = new Map<string, SecretDecl>(
    ((spec.secrets ?? []) as SecretDecl[]).map((s) => [s.name, s]),
  );
  const checkSecretRef = (refName: string, consumer: string, path: string): void => {
    const s = secretsDecl.get(refName);
    if (!s) {
      err(
        'secretRef.undeclared',
        '7.9',
        path,
        `secretRef "${refName}" is not declared in spec.secrets`,
      );
    } else if (!(s.scope ?? []).includes(consumer)) {
      err(
        'secretRef.scope',
        '7.9',
        path,
        `secret "${refName}" is not scoped to "${consumer}" (scope: ${JSON.stringify(s.scope ?? [])})`,
      );
    }
  };

  type McpServerDecl = { name: string; auth?: { secretRef: string }; image?: string };
  const mcpServers = (spec.mcpServers ?? []) as McpServerDecl[];
  const serverNames = new Set(mcpServers.map((s) => s.name));
  mcpServers.forEach((s, i) => {
    needProfile('mcp', 'spec.mcpServers', '/spec/mcpServers', '3.3');
    if (s.auth)
      checkSecretRef(
        s.auth.secretRef,
        s.name,
        pointer('spec', 'mcpServers', i, 'auth', 'secretRef'),
      );
    if (profiles.has('security') && typeof s.image === 'string' && !PINNED_IMAGE.test(s.image)) {
      err(
        'security.image-not-pinned',
        '9.4',
        pointer('spec', 'mcpServers', i, 'image'),
        'container image MUST be pinned by digest under the security profile',
      );
    }
  });
  {
    const seen = new Set<string>();
    mcpServers.forEach((s, i) => {
      if (seen.has(s.name))
        err(
          'name.duplicate',
          '5.5.1',
          pointer('spec', 'mcpServers', i, 'name'),
          `duplicate MCP server name "${s.name}"`,
        );
      seen.add(s.name);
    });
  }

  // 5.5.4: action groups must not contain other groups
  const groups = (spec.actionGroups ?? {}) as Record<string, string[]>;
  for (const [g, members] of Object.entries(groups)) {
    members.forEach((m, i) => {
      if (Object.hasOwn(groups, m) && m !== g) {
        err(
          'actionGroup.nested',
          '5.5.4',
          pointer('spec', 'actionGroups', g, i),
          `group "${g}" contains group "${m}"; groups MUST NOT contain other groups`,
        );
      }
    });
  }

  const checkToolSources = (
    tools: AwpToolSource[] | undefined,
    basePath: (string | number)[],
  ): void => {
    (tools ?? []).forEach((t, i) => {
      if (t.type === 'mcp') {
        needProfile('mcp', 'tool source with type: mcp', pointer(...basePath, i), '3.3');
        if (!serverNames.has(t.server ?? '')) {
          warn(
            'mcp.server-unresolved',
            '5.5.1',
            pointer(...basePath, i, 'server'),
            `MCP server "${t.server}" is not declared in spec.mcpServers; it must be resolvable by runtime binding`,
          );
        }
      }
    });
  };

  const checkPermissions = (
    perm: AwpPermissions | undefined,
    basePath: (string | number)[],
  ): void => {
    for (const s of perm?.secrets ?? []) {
      if (!secretsDecl.has(s))
        warn(
          'permissions.secret-undeclared',
          '7.5.1',
          pointer(...basePath, 'secrets'),
          `permissions.secrets names "${s}", which is not declared in spec.secrets`,
        );
    }
  };

  if (kind === 'Agent') {
    const agent = spec as unknown as AwpAgentSpec;
    checkToolSources(agent.tools, ['spec', 'tools']);
    checkPermissions(agent.permissions, ['spec', 'permissions']);
    checkDate(agent.model?.approval?.expires, '/spec/model/approval/expires');
  }

  if (kind === 'Policy') {
    const seen = new Set<string>();
    ((spec as unknown as AwpPolicySpec).rules ?? []).forEach((r, i) => {
      if (seen.has(r.id))
        err(
          'id.duplicate',
          '8.2',
          pointer('spec', 'rules', i, 'id'),
          `duplicate rule id "${r.id}"`,
        );
      seen.add(r.id);
    });
  }

  if (kind === 'Workflow') {
    const wf = spec as unknown as AwpWorkflowSpec;
    // 3.3 profile-bound fields
    for (const f of ['dataPolicy', 'modelPolicy', 'approval', 'policies', 'environments']) {
      if (spec[f] !== undefined) needProfile('governance', `spec.${f}`, pointer('spec', f), '3.3');
    }
    if (spec.audit !== undefined) needProfile('audit', 'spec.audit', '/spec/audit', '3.3');

    // 3.4: unique identifiers
    type AgentDecl = AwpInlineAgent & {
      ref?: string;
      protocol?: string;
      auth?: { secretRef: string };
    };
    const agents = (wf.agents ?? []) as unknown as AgentDecl[];
    const agentIds = new Set<string>();
    agents.forEach((a, i) => {
      if (agentIds.has(a.id))
        err(
          'id.duplicate',
          '3.4',
          pointer('spec', 'agents', i, 'id'),
          `duplicate agent id "${a.id}"`,
        );
      agentIds.add(a.id);
      if (a.protocol === 'a2a') {
        needProfile('a2a', 'agents with protocol: a2a', pointer('spec', 'agents', i), '3.3');
        if (a.auth)
          checkSecretRef(a.auth.secretRef, a.id, pointer('spec', 'agents', i, 'auth', 'secretRef'));
      }
      if (!a.ref && !a.protocol) checkToolSources(a.tools, ['spec', 'agents', i, 'tools']);
      if (!a.ref && !a.protocol)
        checkDate(
          a.model?.approval?.expires,
          pointer('spec', 'agents', i, 'model', 'approval', 'expires'),
        );
      checkPermissions(a.permissions, ['spec', 'agents', i, 'permissions']);
    });
    checkPermissions(wf.permissions, ['spec', 'permissions']);

    const steps = (wf.workflow ?? []) as AwpStep[];
    const stepIds = new Map<string, number>();
    steps.forEach((s, i) => {
      if (stepIds.has(s.id))
        err(
          'id.duplicate',
          '5.6.3',
          pointer('spec', 'workflow', i, 'id'),
          `duplicate step id "${s.id}"`,
        );
      else stepIds.set(s.id, i);
    });

    // 5.6.3: references and cycles
    const deps = new Map<string, string[]>();
    steps.forEach((s, i) => {
      const own: string[] = [];
      (s.dependsOn ?? []).forEach((d, j) => {
        if (!stepIds.has(d))
          err(
            'dependsOn.unknown-step',
            '5.6.3',
            pointer('spec', 'workflow', i, 'dependsOn', j),
            `dependsOn names non-existent step "${d}"`,
          );
        else own.push(d);
      });
      deps.set(s.id, own);
      if ((s.type ?? 'agent') === 'agent' && s.agent !== undefined && !agentIds.has(s.agent)) {
        err(
          'step.unknown-agent',
          '5.6.3',
          pointer('spec', 'workflow', i, 'agent'),
          `step names non-existent agent "${s.agent}"`,
        );
      }
      if (s.type === 'approval')
        needProfile(
          'governance',
          'step with type: approval',
          pointer('spec', 'workflow', i),
          '3.3',
        );
      if (
        profiles.has('security') &&
        s.type === 'command' &&
        typeof s.image === 'string' &&
        !PINNED_IMAGE.test(s.image)
      ) {
        err(
          'security.image-not-pinned',
          '9.4',
          pointer('spec', 'workflow', i, 'image'),
          'command step image MUST be pinned by digest under the security profile',
        );
      }
      // 5.6.1: retries bound
      const maxRetries = [wf.budget?.resources?.maxRetries, s.budget?.resources?.maxRetries].filter(
        (v): v is number => v !== undefined,
      );
      if (s.retries !== undefined && maxRetries.length && s.retries > Math.min(...maxRetries)) {
        err(
          'retries.exceeds-budget',
          '5.6.1',
          pointer('spec', 'workflow', i, 'retries'),
          `retries (${s.retries}) exceed budget.resources.maxRetries (${Math.min(...maxRetries)})`,
        );
      }
    });

    // cycle detection: iterative depth-first search with colours (no recursion: untrusted depth)
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const visit = (start: string): void => {
      const frames: { id: string; next: number }[] = [{ id: start, next: 0 }];
      state.set(start, 1);
      stack.push(start);
      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        const list = deps.get(frame.id) ?? [];
        if (frame.next >= list.length) {
          stack.pop();
          state.set(frame.id, 2);
          frames.pop();
          continue;
        }
        const d = list[frame.next++]!;
        if (state.get(d) === 1) {
          // the message lists the cycle: build it only for a finding that is kept
          const cyc = out.length < cap ? [...stack.slice(stack.indexOf(d)), d] : [];
          err(
            'dependsOn.cycle',
            '5.6.3',
            pointer('spec', 'workflow', stepIds.get(frame.id)!, 'dependsOn'),
            `dependency cycle: ${cyc.join(' -> ')}`,
          );
        } else if (!state.has(d)) {
          state.set(d, 1);
          stack.push(d);
          frames.push({ id: d, next: 0 });
        }
      }
    };
    for (const id of stepIds.keys()) if (!state.has(id)) visit(id);

    // transitive closure (cycle-safe, memoised per step)
    const closures = new Map<string, Set<string>>();
    const closure = (id: string): Set<string> => {
      const known = closures.get(id);
      if (known) return known;
      const seen = new Set<string>();
      const todo = [...(deps.get(id) ?? [])];
      while (todo.length) {
        const d = todo.pop()!;
        if (!seen.has(d)) {
          seen.add(d);
          todo.push(...(deps.get(d) ?? []));
        }
      }
      closures.set(id, seen);
      return seen;
    };

    // 3.9 / 5.6.3: expression references
    const inputNames = new Set((wf.inputs ?? []).map((i) => i.name));
    const outputsOf = new Map(
      steps.map((s) => [s.id, new Set((s.outputs ?? []).map((o) => o.name))]),
    );
    const checkExpr = (str: unknown, path: string, stepId: string | undefined): void => {
      if (typeof str !== 'string') return;
      for (const m of str.matchAll(EXPR_RE)) {
        const ref = (m[1] ?? '').trim();
        let mm: RegExpExecArray | null;
        if ((mm = /^inputs\.(.+)$/.exec(ref))) {
          if (!inputNames.has(mm[1]!))
            warn(
              'expr.undeclared-input',
              '3.9',
              path,
              `expression references undeclared input "${mm[1]}"`,
            );
        } else if ((mm = /^steps\.([^.]+)\.outputs\.(.+)$/.exec(ref))) {
          const sid = mm[1]!;
          const outName = mm[2]!;
          if (stepId === undefined)
            err(
              'expr.step-reference-outside-step',
              '3.9',
              path,
              `reference to steps.${sid} outside a step`,
            );
          else if (!stepIds.has(sid))
            err(
              'expr.unknown-step',
              '3.9',
              path,
              `expression references non-existent step "${sid}"`,
            );
          else if (!closure(stepId).has(sid))
            err(
              'expr.not-a-dependency',
              '3.9',
              path,
              `step "${stepId}" references steps.${sid} but does not depend on it (directly or transitively)`,
            );
          else if (!outputsOf.get(sid)!.has(outName))
            err(
              'expr.undeclared-output',
              '5.6.3',
              path,
              `step "${sid}" does not declare output "${outName}"`,
            );
        }
      }
    };
    steps.forEach((s, i) => {
      const base = ['spec', 'workflow', i];
      checkExpr(s.task, pointer(...base, 'task'), s.id);
      for (const [k, v] of Object.entries(s.env ?? {}))
        checkExpr(v, pointer(...base, 'env', k), s.id);
      checkExpr(s.approval?.message, pointer(...base, 'approval', 'message'), s.id);
      if (typeof s.command === 'string' && s.command.includes('${{')) {
        warn(
          'lint.command-expression',
          '5.6.2',
          pointer(...base, 'command'),
          'command is not expression-enabled; ${{ }} is passed literally. Use env.',
        );
      }
    });
    const permRes = (perm: AwpPermissions | undefined, base: (string | number)[]): void => {
      for (const [k, t] of Object.entries(perm?.tools ?? {})) {
        (t.resources ?? []).forEach((r, j) =>
          checkExpr(r, pointer(...base, 'tools', k, 'resources', j), undefined),
        );
      }
    };
    permRes(wf.permissions, ['spec', 'permissions']);
    agents.forEach((a, i) => permRes(a.permissions, ['spec', 'agents', i, 'permissions']));
    checkExpr(wf.approval?.message, '/spec/approval/message', undefined);

    // 5.3: inputs
    (wf.inputs ?? []).forEach((inp, i) => {
      if (typeof inp.pattern === 'string') {
        try {
          new RegExp(inp.pattern, 'u');
        } catch {
          err(
            'input.pattern-invalid',
            '5.3',
            pointer('spec', 'inputs', i, 'pattern'),
            'pattern is not a valid ECMA-262 regular expression',
          );
        }
      }
    });

    // 7.10: environment.name should be listed when environments is declared (lint only)
    if (wf.environments && wf.environment && !Object.hasOwn(wf.environments, wf.environment.name)) {
      warn(
        'lint.environment-not-listed',
        '7.10',
        '/spec/environment/name',
        `default environment "${wf.environment.name}" is not listed in spec.environments; executions would not start`,
      );
    }

    // 7.5.3: absent permissions
    if (wf.permissions === undefined && profiles.has('security')) {
      warn(
        'lint.permissions-absent',
        '7.5.3',
        '/spec',
        'no spec.permissions: every action of exposed tools is allowed by permissions',
      );
    }
  }
  return out;
}

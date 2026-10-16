// Semantic validation rules of AWP v1alpha1 that JSON Schema cannot express.
// Rule catalogue: schema/README.md. Every diagnostic has a stable `code`.
// Runs on documents that already passed the structural schema.

import { createHash } from 'node:crypto';

export const KNOWN_PROFILES = ['core', 'governance', 'audit', 'security', 'mcp', 'a2a'];

const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;
const SECRET_FIELD_NAMES = new Set(['token', 'password', 'apiKey', 'secret', 'privateKey']);

const esc = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const ptr = (...parts) => parts.map(p => '/' + esc(p)).join('');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function jcs(value) {
  // JSON Canonicalization Scheme (RFC 8785) for the JSON subset used by manifests.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}

export function manifestDigest(doc, algorithm = 'sha256') {
  const copy = structuredClone(doc);
  if (copy.metadata) {
    delete copy.metadata.integrity;
    delete copy.metadata.signature;
    delete copy.metadata.provenance;
  }
  return `${algorithm}:${createHash(algorithm).update(jcs(copy), 'utf8').digest('hex')}`;
}

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function forEachNode(node, fn, path = []) {
  fn(node, path);
  if (Array.isArray(node)) node.forEach((v, i) => forEachNode(v, fn, [...path, i]));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('x-')) continue; // extension subtrees are opaque (spec 3.3)
      forEachNode(v, fn, [...path, k]);
    }
  }
}

/**
 * @param {object} doc parsed manifest
 * @param {{profiles?: string[], verifyDigest?: boolean}} opts
 * @returns {{severity:string, code:string, message:string, path:string, section:string}[]}
 */
export function semanticCheck(doc, opts = {}) {
  const profiles = new Set(opts.profiles ?? KNOWN_PROFILES);
  const out = [];
  const add = (severity, code, section, path, message) => out.push({ severity, code, message, path, section });
  const err = (code, section, path, message) => add('error', code, section, path, message);
  const warn = (code, section, path, message) => add('warning', code, section, path, message);
  const needProfile = (profile, field, path, section) => {
    if (!profiles.has(profile)) {
      err('profile.unsupported', section, path, `field ${field} belongs to the "${profile}" profile, which is not supported`);
    }
  };

  const kind = doc.kind;
  const meta = doc.metadata ?? {};
  const spec = doc.spec ?? {};

  // 3.8 / 9.1: digest verification and algorithm support
  forEachNode(doc, (n, p) => {
    if (isObj(n) && typeof n.digest === 'string') {
      const alg = n.digest.split(':')[0];
      if (!['sha256', 'sha384', 'sha512'].includes(alg)) {
        warn('digest.algorithm-unknown', '3.8', ptr(...p, 'digest'), `digest algorithm "${alg}" is not one of sha256, sha384, sha512; verification is impossible where required`);
      }
    }
  });
  if (opts.verifyDigest && meta.integrity?.digest) {
    const alg = meta.integrity.digest.split(':')[0];
    if (!['sha256', 'sha384', 'sha512'].includes(alg)) {
      err('digest.unsupported-algorithm', '9.1', '/metadata/integrity/digest', `cannot verify digest algorithm "${alg}"`);
    } else {
      const expected = manifestDigest(doc, alg);
      if (expected !== meta.integrity.digest) {
        err('digest.mismatch', '9.1', '/metadata/integrity/digest', `metadata.integrity.digest does not match the manifest (computed ${expected})`);
      }
    }
  }

  // 7.9: literal credential fields anywhere outside x- extensions
  forEachNode(doc, (n, p) => {
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (SECRET_FIELD_NAMES.has(k) && v !== null && typeof v !== 'object') {
        err('secret.literal-field', '7.9', ptr(...p, k), `field "${k}" with a literal value; secrets MUST NOT appear in manifests, use secretRef`);
      }
    }
  });

  // 3.7: calendar validity of dates
  const checkDate = (s, path) => {
    if (typeof s === 'string' && !validDate(s)) err('date.invalid', '3.7', path, `"${s}" is not a valid calendar date`);
  };

  // 3.3: profile-bound fields
  if (meta.risk && ['high', 'critical'].includes(meta.risk.level)) {
    needProfile('governance', `metadata.risk.level: ${meta.risk.level}`, '/metadata/risk/level', '3.3');
  }
  if (meta.signature) needProfile('security', 'metadata.signature', '/metadata/signature', '3.3');
  if (kind === 'Policy') needProfile('governance', 'kind: Policy', '/kind', '3.3');

  // 7.1: governance profile requirements
  if (profiles.has('governance') && (kind === 'Workflow' || kind === 'Agent') && meta.classification === undefined) {
    err('governance.classification-required', '7.1', '/metadata', 'metadata.classification is REQUIRED for Workflow and Agent under the governance profile');
  }

  const secretsDecl = new Map((spec.secrets ?? []).map(s => [s.name, s]));
  const checkSecretRef = (refName, consumer, path) => {
    const s = secretsDecl.get(refName);
    if (!s) {
      err('secretRef.undeclared', '7.9', path, `secretRef "${refName}" is not declared in spec.secrets`);
    } else if (!(s.scope ?? []).includes(consumer)) {
      err('secretRef.scope', '7.9', path, `secret "${refName}" is not scoped to "${consumer}" (scope: ${JSON.stringify(s.scope ?? [])})`);
    }
  };

  const mcpServers = spec.mcpServers ?? [];
  const serverNames = new Set(mcpServers.map(s => s.name));
  mcpServers.forEach((s, i) => {
    needProfile('mcp', 'spec.mcpServers', '/spec/mcpServers', '3.3');
    if (s.auth) checkSecretRef(s.auth.secretRef, s.name, ptr('spec', 'mcpServers', i, 'auth', 'secretRef'));
    if (profiles.has('security') && typeof s.image === 'string' && !/@(sha256:[0-9a-f]{64}|sha384:[0-9a-f]{96}|sha512:[0-9a-f]{128})$/.test(s.image)) {
      err('security.image-not-pinned', '9.4', ptr('spec', 'mcpServers', i, 'image'), 'container image MUST be pinned by digest under the security profile');
    }
  });
  for (const [dupName, list] of [['mcpServers', mcpServers]]) {
    const seen = new Set();
    list.forEach((s, i) => {
      if (seen.has(s.name)) err('name.duplicate', '5.5.1', ptr('spec', dupName, i, 'name'), `duplicate MCP server name "${s.name}"`);
      seen.add(s.name);
    });
  }

  // 5.5.4: action groups must not contain other groups
  const groups = spec.actionGroups ?? {};
  for (const [g, members] of Object.entries(groups)) {
    members.forEach((m, i) => {
      if (Object.hasOwn(groups, m) && m !== g) {
        err('actionGroup.nested', '5.5.4', ptr('spec', 'actionGroups', g, i), `group "${g}" contains group "${m}"; groups MUST NOT contain other groups`);
      }
    });
  }

  const checkToolSources = (tools, basePath) => {
    (tools ?? []).forEach((t, i) => {
      if (t.type === 'mcp') {
        needProfile('mcp', 'tool source with type: mcp', ptr(...basePath, i), '3.3');
        if (!serverNames.has(t.server)) {
          warn('mcp.server-unresolved', '5.5.1', ptr(...basePath, i, 'server'), `MCP server "${t.server}" is not declared in spec.mcpServers; it must be resolvable by runtime binding`);
        }
      }
    });
  };

  const checkPermissions = (perm, basePath) => {
    for (const s of perm?.secrets ?? []) {
      if (!secretsDecl.has(s)) warn('permissions.secret-undeclared', '7.5.1', ptr(...basePath, 'secrets'), `permissions.secrets names "${s}", which is not declared in spec.secrets`);
    }
  };

  if (kind === 'Agent') {
    checkToolSources(spec.tools, ['spec', 'tools']);
    checkPermissions(spec.permissions, ['spec', 'permissions']);
    checkDate(spec.model?.approval?.expires, '/spec/model/approval/expires');
  }

  if (kind === 'Policy') {
    const seen = new Set();
    (spec.rules ?? []).forEach((r, i) => {
      if (seen.has(r.id)) err('id.duplicate', '8.2', ptr('spec', 'rules', i, 'id'), `duplicate rule id "${r.id}"`);
      seen.add(r.id);
    });
  }

  if (kind === 'Workflow') {
    // 3.3 profile-bound fields
    const gov = ['dataPolicy', 'modelPolicy', 'approval', 'policies', 'environments'];
    for (const f of gov) if (spec[f] !== undefined) needProfile('governance', `spec.${f}`, ptr('spec', f), '3.3');
    if (spec.audit !== undefined) needProfile('audit', 'spec.audit', '/spec/audit', '3.3');

    // 3.4: unique identifiers
    const agentIds = new Set();
    (spec.agents ?? []).forEach((a, i) => {
      if (agentIds.has(a.id)) err('id.duplicate', '3.4', ptr('spec', 'agents', i, 'id'), `duplicate agent id "${a.id}"`);
      agentIds.add(a.id);
      if (a.protocol === 'a2a') {
        needProfile('a2a', 'agents with protocol: a2a', ptr('spec', 'agents', i), '3.3');
        if (a.auth) checkSecretRef(a.auth.secretRef, a.id, ptr('spec', 'agents', i, 'auth', 'secretRef'));
      }
      if (!a.ref && !a.protocol) checkToolSources(a.tools, ['spec', 'agents', i, 'tools']);
      if (!a.ref && !a.protocol) checkDate(a.model?.approval?.expires, ptr('spec', 'agents', i, 'model', 'approval', 'expires'));
      checkPermissions(a.permissions, ['spec', 'agents', i, 'permissions']);
    });
    checkPermissions(spec.permissions, ['spec', 'permissions']);

    const steps = spec.workflow ?? [];
    const stepIds = new Map();
    steps.forEach((s, i) => {
      if (stepIds.has(s.id)) err('id.duplicate', '5.6.3', ptr('spec', 'workflow', i, 'id'), `duplicate step id "${s.id}"`);
      else stepIds.set(s.id, i);
    });

    // 5.6.3: references and cycles
    const deps = new Map();
    steps.forEach((s, i) => {
      const own = [];
      (s.dependsOn ?? []).forEach((d, j) => {
        if (!stepIds.has(d)) err('dependsOn.unknown-step', '5.6.3', ptr('spec', 'workflow', i, 'dependsOn', j), `dependsOn names non-existent step "${d}"`);
        else own.push(d);
      });
      deps.set(s.id, own);
      if ((s.type ?? 'agent') === 'agent' && s.agent !== undefined && !agentIds.has(s.agent)) {
        err('step.unknown-agent', '5.6.3', ptr('spec', 'workflow', i, 'agent'), `step names non-existent agent "${s.agent}"`);
      }
      if (s.type === 'approval') needProfile('governance', 'step with type: approval', ptr('spec', 'workflow', i), '3.3');
      if (profiles.has('security') && s.type === 'command' && typeof s.image === 'string' && !/@(sha256:[0-9a-f]{64}|sha384:[0-9a-f]{96}|sha512:[0-9a-f]{128})$/.test(s.image)) {
        err('security.image-not-pinned', '9.4', ptr('spec', 'workflow', i, 'image'), 'command step image MUST be pinned by digest under the security profile');
      }
      // 5.6.1: retries bound
      const maxRetries = [spec.budget?.resources?.maxRetries, s.budget?.resources?.maxRetries].filter(v => v !== undefined);
      if (s.retries !== undefined && maxRetries.length && s.retries > Math.min(...maxRetries)) {
        err('retries.exceeds-budget', '5.6.1', ptr('spec', 'workflow', i, 'retries'), `retries (${s.retries}) exceed budget.resources.maxRetries (${Math.min(...maxRetries)})`);
      }
    });
    // cycle detection (DFS, colours)
    const state = new Map();
    const stack = [];
    const visit = id => {
      state.set(id, 1); stack.push(id);
      for (const d of deps.get(id) ?? []) {
        if (state.get(d) === 1) {
          const cyc = [...stack.slice(stack.indexOf(d)), d];
          err('dependsOn.cycle', '5.6.3', ptr('spec', 'workflow', stepIds.get(id), 'dependsOn'), `dependency cycle: ${cyc.join(' -> ')}`);
        } else if (!state.has(d)) visit(d);
      }
      stack.pop(); state.set(id, 2);
    };
    for (const id of stepIds.keys()) if (!state.has(id)) visit(id);

    // transitive closure (cycle-safe)
    const closure = id => {
      const seen = new Set(); const todo = [...(deps.get(id) ?? [])];
      while (todo.length) { const d = todo.pop(); if (!seen.has(d)) { seen.add(d); todo.push(...(deps.get(d) ?? [])); } }
      return seen;
    };

    // 3.9 / 5.6.3: expression references
    const inputNames = new Set((spec.inputs ?? []).map(i => i.name));
    const outputsOf = new Map(steps.map(s => [s.id, new Set((s.outputs ?? []).map(o => o.name))]));
    const checkExpr = (str, path, stepId) => {
      if (typeof str !== 'string') return;
      for (const m of str.matchAll(EXPR_RE)) {
        const ref = m[1].trim();
        let mm;
        if ((mm = /^inputs\.(.+)$/.exec(ref))) {
          if (!inputNames.has(mm[1])) warn('expr.undeclared-input', '3.9', path, `expression references undeclared input "${mm[1]}"`);
        } else if ((mm = /^steps\.([^.]+)\.outputs\.(.+)$/.exec(ref))) {
          const [, sid, out] = mm;
          if (stepId === undefined) err('expr.step-reference-outside-step', '3.9', path, `reference to steps.${sid} outside a step`);
          else if (!stepIds.has(sid)) err('expr.unknown-step', '3.9', path, `expression references non-existent step "${sid}"`);
          else if (!closure(stepId).has(sid)) err('expr.not-a-dependency', '3.9', path, `step "${stepId}" references steps.${sid} but does not depend on it (directly or transitively)`);
          else if (!outputsOf.get(sid).has(out)) err('expr.undeclared-output', '5.6.3', path, `step "${sid}" does not declare output "${out}"`);
        }
      }
    };
    steps.forEach((s, i) => {
      const base = ['spec', 'workflow', i];
      checkExpr(s.task, ptr(...base, 'task'), s.id);
      for (const [k, v] of Object.entries(s.env ?? {})) checkExpr(v, ptr(...base, 'env', k), s.id);
      checkExpr(s.approval?.message, ptr(...base, 'approval', 'message'), s.id);
      if (typeof s.command === 'string' && s.command.includes('${{')) {
        warn('lint.command-expression', '5.6.2', ptr(...base, 'command'), 'command is not expression-enabled; ${{ }} is passed literally. Use env.');
      }
    });
    const permRes = (perm, base) => {
      for (const [k, t] of Object.entries(perm?.tools ?? {})) {
        (t.resources ?? []).forEach((r, j) => checkExpr(r, ptr(...base, 'tools', k, 'resources', j), undefined));
      }
    };
    permRes(spec.permissions, ['spec', 'permissions']);
    (spec.agents ?? []).forEach((a, i) => permRes(a.permissions, ['spec', 'agents', i, 'permissions']));
    checkExpr(spec.approval?.message, '/spec/approval/message', undefined);

    // 5.3: inputs
    (spec.inputs ?? []).forEach((inp, i) => {
      if (typeof inp.pattern === 'string') {
        try { new RegExp(inp.pattern, 'u'); } catch { err('input.pattern-invalid', '5.3', ptr('spec', 'inputs', i, 'pattern'), 'pattern is not a valid ECMA-262 regular expression'); }
      }
    });

    // 7.10: environment.name should be listed when environments is declared (runtime rule; lint only)
    if (spec.environments && spec.environment && !Object.hasOwn(spec.environments, spec.environment.name)) {
      warn('lint.environment-not-listed', '7.10', '/spec/environment/name', `default environment "${spec.environment.name}" is not listed in spec.environments; executions would not start`);
    }

    // 7.5.3: absent permissions
    if (spec.permissions === undefined && profiles.has('security')) {
      warn('lint.permissions-absent', '7.5.3', '/spec', 'no spec.permissions: every action of exposed tools is allowed by permissions');
    }
  }
  return out;
}

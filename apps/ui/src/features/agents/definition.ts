/** Read-only view of a parsed agents.md definition (as returned by the API, loosely typed). */
export interface ToolView {
  server: string;
  tool: string;
  approval: boolean;
  maxCallsPerRun?: number;
  args: string[];
}
export interface AgentSpecView {
  id: string;
  provider: string;
  model: string;
  toolbox?: string;
  outputs: string[];
  tools: ToolView[];
}
export interface TriggerView {
  type: string;
  detail: string;
}
export interface DefinitionView {
  name?: string;
  version?: string;
  description?: string;
  owner?: string;
  classification?: string;
  runner?: string;
  toolbox?: string;
  egress: string[];
  triggers: TriggerView[];
  budget: Record<string, number>;
  approverRoles: string[];
  agents: AgentSpecView[];
  pipeline: string[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function triggerDetail(t: Record<string, unknown>): string {
  return str(t.source) ?? str(t.topic) ?? str(t.schedule) ?? '';
}

export function readDefinition(definition: unknown): DefinitionView {
  const d = obj(definition);
  const runtime = obj(d.runtime);
  const budget: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(d.budget))) if (typeof v === 'number') budget[k] = v;
  const agents = arr(d.agents).map((a): AgentSpecView => {
    const spec = obj(a);
    const view: AgentSpecView = {
      id: str(spec.id) ?? '?',
      provider: str(spec.provider) ?? '?',
      model: str(spec.model) ?? '?',
      outputs: arr(spec.outputs).map((o) => str(obj(o).format) ?? '?'),
      tools: arr(spec.tools).map((tl): ToolView => {
        const g = obj(tl);
        const tool: ToolView = {
          server: str(g.server) ?? '?',
          tool: str(g.tool) ?? '?',
          approval: g.approval === 'required',
          args: Object.keys(obj(g.args)),
        };
        if (typeof g.maxCallsPerRun === 'number') tool.maxCallsPerRun = g.maxCallsPerRun;
        return tool;
      }),
    };
    const toolbox = str(spec.toolbox);
    if (toolbox) view.toolbox = toolbox;
    return view;
  });
  const view: DefinitionView = {
    egress: arr(runtime.egress).filter((e): e is string => typeof e === 'string'),
    triggers: arr(d.triggers).map((tr) => {
      const t = obj(tr);
      return { type: str(t.type) ?? '?', detail: triggerDetail(t) };
    }),
    budget,
    approverRoles: arr(obj(d.approvals).approverRoles).filter(
      (r): r is string => typeof r === 'string',
    ),
    agents,
    pipeline: arr(d.pipeline).filter((p): p is string => typeof p === 'string'),
  };
  const fields = ['name', 'version', 'description', 'owner', 'classification'] as const;
  for (const f of fields) {
    const v = str(d[f]);
    if (v) view[f] = v;
  }
  const runner = str(runtime.runner);
  if (runner) view.runner = runner;
  const toolbox = str(runtime.toolbox);
  if (toolbox) view.toolbox = toolbox;
  return view;
}

/** Best-effort hints from a draft source (no YAML parser in the bundle). */
export function draftHints(source: string): {
  toolbox?: string;
  runner?: string;
  providers: string[];
} {
  const toolbox = /^\s+toolbox:\s*["']?([a-z0-9+-]+)/m.exec(source)?.[1];
  const runner = /^\s+runner:\s*["']?([a-z-]+)/m.exec(source)?.[1];
  const providers = [...source.matchAll(/^\s+provider:\s*["']?([\w.-]+)/gm)].map((m) => m[1] ?? '');
  const out: { toolbox?: string; runner?: string; providers: string[] } = {
    providers: [...new Set(providers)],
  };
  if (toolbox) out.toolbox = toolbox;
  if (runner) out.runner = runner;
  return out;
}

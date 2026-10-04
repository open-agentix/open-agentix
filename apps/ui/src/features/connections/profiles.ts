/** Tool classes and named profiles inside the config of an MCP connection (ADR 0008). */
export type ToolAccess = 'read' | 'write';

export interface ToolAccessConfig {
  tools: Record<string, ToolAccess>;
  profiles: Record<string, string[]>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads `tools` and `profiles`; anything that is not in the new shape is ignored. */
export function readToolAccess(config: Record<string, unknown>): ToolAccessConfig {
  const tools: Record<string, ToolAccess> = {};
  if (isObject(config.tools))
    for (const [name, v] of Object.entries(config.tools))
      if (isObject(v) && (v.access === 'read' || v.access === 'write')) tools[name] = v.access;
  const profiles: Record<string, string[]> = {};
  if (isObject(config.profiles))
    for (const [name, v] of Object.entries(config.profiles))
      if (Array.isArray(v)) profiles[name] = v.filter((m): m is string => typeof m === 'string');
  return { tools, profiles };
}

/** Writes `tools` and `profiles` back; empty maps are removed from the config. */
export function writeToolAccess(
  config: Record<string, unknown>,
  access: ToolAccessConfig,
): Record<string, unknown> {
  const { tools: _t, profiles: _p, ...rest } = config;
  return {
    ...rest,
    ...(Object.keys(access.tools).length
      ? {
          tools: Object.fromEntries(
            Object.entries(access.tools).map(([n, a]) => [n, { access: a }]),
          ),
        }
      : {}),
    ...(Object.keys(access.profiles).length ? { profiles: access.profiles } : {}),
  };
}

export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Client-side hints that mirror the server rules (the server stays authoritative). */
export function accessProblems(a: ToolAccessConfig): string[] {
  const out: string[] = [];
  for (const [name, members] of Object.entries(a.profiles)) {
    for (const m of members) {
      if (!(m in a.tools)) out.push(`${name}: ${m}`);
      else if (name === 'read' && a.tools[m] !== 'read') out.push(`read: ${m}`);
    }
  }
  return out;
}

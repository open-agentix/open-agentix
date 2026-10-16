/**
 * Every property of the pinned AWP schema outside the `^x-` extension pattern, as a path such as
 * `Workflow.spec.agents[].tools[].type` (`[]` = array item, `{}` = value of a map). Used by the
 * field-coverage drift test: a property that appears in the schema must be handled or listed as
 * knowingly rejected in `data/awp-field-coverage.json`.
 */
type Schema = Record<string, unknown>;

export function schemaPropertyPaths(
  schema: Schema,
  roots = ['Workflow', 'Agent', 'Policy'],
): string[] {
  const defs = schema.$defs as Record<string, Schema>;
  const out = new Set<string>();

  const walk = (node: unknown, path: string, active: readonly string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const s = node as Schema;
    if (typeof s.$ref === 'string') {
      const name = s.$ref.replace('#/$defs/', '');
      if (active.includes(name)) return; // recursive definition: its properties are already listed
      walk(defs[name], path, [...active, name]);
      return;
    }
    const props = s.properties as Record<string, Schema> | undefined;
    for (const [key, sub] of Object.entries(props ?? {})) {
      const child = path ? `${path}.${key}` : key;
      out.add(child);
      walk(sub, child, active);
    }
    if (s.items) walk(s.items, `${path}[]`, active);
    if (s.additionalProperties && typeof s.additionalProperties === 'object')
      walk(s.additionalProperties, `${path}{}`, active);
    for (const k of ['oneOf', 'anyOf', 'allOf'] as const)
      for (const b of (s[k] as Schema[] | undefined) ?? []) walk(b, path, active);
    for (const k of ['if', 'then', 'else'] as const) walk(s[k], path, active);
  };

  for (const root of roots) walk(defs[root], root, [root]);
  return [...out].sort();
}

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSIONS_FILE,
  OUT_DIR,
  REPO_ROOT,
  SCHEMA_FILE,
  generate,
  main,
} from '../../../scripts/awp/generate-types.mjs';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch repository root holding copies of the two inputs. */
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'oax-gen-'));
  tmpDirs.push(root);
  for (const file of [SCHEMA_FILE, EXTENSIONS_FILE]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(REPO_ROOT, file), path.join(root, file));
  }
  return root;
}
const sink = () => {
  const lines: string[] = [];
  return { lines, out: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
};

describe('generate-types', () => {
  it('the committed generated files are current (CI runs --check)', () => {
    const { lines, out } = sink();
    expect(main(['--check'], out)).toBe(0);
    expect(lines.join('\n')).toMatch(/current/);
  });

  it('writes, then --check passes; a hand edit or a missing file fails and names the file', () => {
    const root = scratch();
    const w = sink();
    expect(main([], w.out, root)).toBe(0);
    expect(main(['--check'], sink().out, root)).toBe(0);
    for (const name of ['awp-types.ts', 'awp-schema.ts', 'extensions-schema.ts']) {
      const file = path.join(root, OUT_DIR, name);
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, `${original}\n// edited by hand\n`);
      const c = sink();
      expect(main(['--check'], c.out, root)).toBe(1);
      expect(c.lines.join('\n')).toContain(`stale or edited: ${OUT_DIR}/${name}`);
      writeFileSync(file, original);
    }
    rmSync(path.join(root, OUT_DIR, 'awp-types.ts'));
    const c = sink();
    expect(main(['--check'], c.out, root)).toBe(1);
    expect(c.lines.join('\n')).toContain('awp-types.ts');
  });

  it('a schema that gains a property changes the generated types (--check goes red)', () => {
    const root = scratch();
    main([], sink().out, root);
    const file = path.join(root, SCHEMA_FILE);
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    schema.$defs.Metadata.properties.requiredExtensions = {
      type: 'array',
      items: { type: 'string' },
    };
    writeFileSync(file, JSON.stringify(schema));
    expect(main(['--check'], sink().out, root)).toBe(1);
    const types = generate(root)[`${OUT_DIR}/awp-types.ts`]!;
    expect(types).toContain('requiredExtensions?: string[];');
  });

  it('refuses constructs it cannot type instead of guessing', () => {
    const root = scratch();
    const file = path.join(root, SCHEMA_FILE);
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    schema.$defs.Name = { type: 'object', properties: { a: { $ref: 'https://x/y.json' } } };
    writeFileSync(file, JSON.stringify(schema));
    expect(() => generate(root)).toThrow(/unsupported \$ref/);
    schema.$defs.Name = { type: 'object', patternProperties: { '^y-': {} } };
    writeFileSync(file, JSON.stringify(schema));
    expect(() => generate(root)).toThrow(/patternProperties/);
  });

  it('rejects unknown arguments', () => {
    const { lines, out } = sink();
    expect(main(['--write-everything'], out)).toBe(2);
    expect(lines[0]).toMatch(/usage/);
  });

  it('records the hash of its inputs in every generated file', () => {
    for (const content of Object.values(generate()))
      expect(content).toMatch(/\(sha256 [0-9a-f]{64}\)/);
  });
});

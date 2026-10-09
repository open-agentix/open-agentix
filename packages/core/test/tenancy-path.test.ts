import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_TENANT_DEPTH,
  ancestorIds,
  isDescendantPath,
  isValidPath,
  nodeIdOf,
  parseSlugPath,
  pathDepth,
  pathIds,
  placeNode,
  resolveMaxDepth,
  rootPath,
  subtreePrefix,
  wouldCreateCycle,
} from '../src/index.js';

const root = () => {
  const id = randomUUID();
  return { id, ...placeNode(id, null) };
};
const child = (parent: { id: string; rootId: string; path: string }, maxDepth?: number) => {
  const id = randomUUID();
  return { id, ...placeNode(id, parent, maxDepth) };
};

describe('tenant paths', () => {
  it('places a root at depth 0 with itself as root', () => {
    const r = root();
    expect(r).toMatchObject({ parentId: null, rootId: r.id, depth: 0, path: `/${r.id}/` });
    expect(rootPath(r.id)).toBe(r.path);
    expect(isValidPath(r.path)).toBe(true);
    expect(pathDepth(r.path)).toBe(0);
    expect(ancestorIds(r.path)).toEqual([]);
    expect(nodeIdOf(r.path)).toBe(r.id);
  });

  it('builds the chain of a descendant, root first', () => {
    const r = root();
    const a = child(r);
    const b = child(a);
    expect(b).toMatchObject({ parentId: a.id, rootId: r.id, depth: 2 });
    expect(pathIds(b.path)).toEqual([r.id, a.id, b.id]);
    expect(ancestorIds(b.path)).toEqual([r.id, a.id]);
    expect(isDescendantPath(b.path, r.path)).toBe(true);
    expect(isDescendantPath(r.path, b.path)).toBe(false);
    expect(isDescendantPath(r.path, r.path)).toBe(false);
    expect(subtreePrefix(a.path)).toBe(`${a.path}%`);
  });

  it('does not treat siblings or other organisations as descendants', () => {
    const r = root();
    const a = child(r);
    const b = child(r);
    expect(isDescendantPath(b.path, a.path)).toBe(false);
    expect(isDescendantPath(root().path, r.path)).toBe(false);
  });

  it('refuses cycles, including a node below itself', () => {
    const r = root();
    const a = child(r);
    expect(wouldCreateCycle(r.id, a.path)).toBe(true);
    expect(() => placeNode(r.id, a)).toThrow(/own ancestor/);
    expect(() => placeNode(a.id, a)).toThrow(/own ancestor/);
    expect(wouldCreateCycle(randomUUID(), a.path)).toBe(false);
  });

  it('enforces the configured depth and the technical maximum of 32', () => {
    let node = root();
    for (let i = 1; i <= MAX_TENANT_DEPTH; i++) node = { ...node, ...child(node) };
    expect(node.depth).toBe(MAX_TENANT_DEPTH);
    expect(isValidPath(node.path)).toBe(true);
    expect(() => placeNode(randomUUID(), node)).toThrow(/exceeds 32/);
    const r = root();
    const a = child(r, 1);
    expect(() => placeNode(randomUUID(), a, 1)).toThrow(/exceeds 1/);
    expect(() => placeNode(randomUUID(), a, 2)).not.toThrow();
  });

  it('validates the depth setting', () => {
    expect(resolveMaxDepth(undefined)).toBe(32);
    expect(resolveMaxDepth(2)).toBe(2);
    for (const bad of [0, 33, 1.5, Number.NaN]) expect(() => resolveMaxDepth(bad)).toThrow();
  });

  it('rejects malformed ids and paths', () => {
    expect(() => rootPath('nope')).toThrow();
    expect(() => placeNode('NOT-A-UUID', null)).toThrow();
    expect(() => pathIds('/abc/')).toThrow();
    expect(() => subtreePrefix("/x'%/")).toThrow();
    expect(isValidPath(`/${randomUUID()}`)).toBe(false);
    const r = root();
    expect(() => placeNode(randomUUID(), { ...r, path: '/bad/' })).toThrow(/malformed/);
    expect(() => placeNode(randomUUID(), { ...r, id: randomUUID() })).toThrow(/end with/);
  });

  it('parses slug paths', () => {
    expect(parseSlugPath('acme/div-a/team-a')).toEqual(['acme', 'div-a', 'team-a']);
    expect(parseSlugPath('acme')).toEqual(['acme']);
    for (const bad of ['', 'acme//x', '/acme', 'Acme/x', 'acme/x/', '1abc', 'a/../b'])
      expect(() => parseSlugPath(bad)).toThrow();
    expect(() => parseSlugPath(Array(40).fill('a').join('/'))).toThrow();
  });
});

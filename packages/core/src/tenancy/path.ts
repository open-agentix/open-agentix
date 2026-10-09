import { OaxError } from '../errors.js';

/**
 * Tenant tree helpers (ADR 0013 section 2). A tenant's `path` is the ids of its chain, root first:
 * `/<uuid>/<uuid>/.../`. The subtree of a node is every row whose path starts with the node's path,
 * the chain of a node is the list of ids inside its own path. Everything here is pure; the database
 * enforces the same rules with check constraints and a trigger (migration 0013).
 */

/** Technical safety maximum of levels below a root (database check `depth <= 32`). */
export const MAX_TENANT_DEPTH = 32;

/** Default structure offered by the console: organisation -> department -> team. */
export const DEFAULT_TENANT_STRUCTURE_DEPTH = 2;

/** Default guard against runaway automation: nodes per organisation. */
export const DEFAULT_MAX_NODES_PER_ROOT = 1000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const PATH_RE = new RegExp(`^(?:/${UUID})+/$`);

/** Slug of one node: same rule as the API (`^[a-z][a-z0-9-]{0,62}$`). */
export const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Characters a path occupies per level (`/` plus a 36 character uuid). */
const CHARS_PER_LEVEL = 37;

export interface TenantPlacement {
  parentId: string | null;
  rootId: string;
  path: string;
  depth: number;
}

function invalid(message: string): never {
  throw new OaxError('invalid_tenant_path', message);
}

/** Validates the maximum depth setting (1 to the technical maximum). */
export function resolveMaxDepth(configured: number | undefined): number {
  const max = configured ?? MAX_TENANT_DEPTH;
  if (!Number.isInteger(max) || max < 1 || max > MAX_TENANT_DEPTH)
    invalid(`tenant depth limit must be an integer from 1 to ${MAX_TENANT_DEPTH}`);
  return max;
}

/** Path of a root: `/<id>/`. */
export function rootPath(id: string): string {
  if (!UUID_RE.test(id)) invalid('tenant id must be a lower case uuid');
  return `/${id}/`;
}

/** True for a well-formed path whose length matches its number of levels. */
export function isValidPath(path: string): boolean {
  return PATH_RE.test(path) && path.length === CHARS_PER_LEVEL * pathIds(path).length + 1;
}

/** The ids of the chain, root first. */
export function pathIds(path: string): string[] {
  if (!PATH_RE.test(path)) invalid('malformed tenant path');
  return path.split('/').filter(Boolean);
}

/** Depth of a node (0 for a root) as encoded in its path. */
export function pathDepth(path: string): number {
  return pathIds(path).length - 1;
}

/** Ancestors of a node, root first, excluding the node itself. */
export function ancestorIds(path: string): string[] {
  return pathIds(path).slice(0, -1);
}

/** Id of the last path element (the node itself). */
export function nodeIdOf(path: string): string {
  return pathIds(path).at(-1)!;
}

/**
 * Placement of a new node below `parent` (or as a root when `parent` is null).
 * Refuses a cycle (the new id is already in the parent's chain, which also covers `id == parent`)
 * and a depth above `maxDepth`.
 */
export function placeNode(
  id: string,
  parent: Pick<TenantPlacement, 'rootId' | 'path'> & { id: string },
  maxDepth?: number,
): TenantPlacement;
export function placeNode(id: string, parent: null, maxDepth?: number): TenantPlacement;
export function placeNode(
  id: string,
  parent: (Pick<TenantPlacement, 'rootId' | 'path'> & { id: string }) | null,
  maxDepth?: number,
): TenantPlacement {
  const limit = resolveMaxDepth(maxDepth);
  if (!UUID_RE.test(id)) invalid('tenant id must be a lower case uuid');
  if (!parent) return { parentId: null, rootId: id, path: rootPath(id), depth: 0 };
  if (!isValidPath(parent.path)) invalid('malformed parent path');
  if (nodeIdOf(parent.path) !== parent.id) invalid('parent path does not end with the parent id');
  if (wouldCreateCycle(id, parent.path)) invalid('a tenant cannot be its own ancestor');
  const depth = pathDepth(parent.path) + 1;
  if (depth > limit)
    throw new OaxError('tenant_depth_exceeded', `tenant depth ${depth} exceeds ${limit}`);
  return { parentId: parent.id, rootId: parent.rootId, path: `${parent.path}${id}/`, depth };
}

/** True when attaching `nodeId` below the node at `parentPath` would loop. */
export function wouldCreateCycle(nodeId: string, parentPath: string): boolean {
  return pathIds(parentPath).includes(nodeId);
}

/** True when `candidatePath` lies strictly below `ancestorPath`. */
export function isDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath !== ancestorPath && candidatePath.startsWith(ancestorPath);
}

/**
 * Prefix for a subtree query (`path like :prefix`, node included). The path holds only hex digits,
 * dashes and slashes, so it needs no `like` escaping; anything else is refused.
 */
export function subtreePrefix(path: string): string {
  if (!isValidPath(path)) invalid('malformed tenant path');
  return `${path}%`;
}

/** Splits an `acme/div-a/team-a` slug path into validated segments. */
export function parseSlugPath(input: string): string[] {
  const parts = input.split('/');
  if (parts.length > MAX_TENANT_DEPTH + 1 || parts.some((s) => !TENANT_SLUG_RE.test(s)))
    invalid('slug path must be slugs separated by "/"');
  return parts;
}

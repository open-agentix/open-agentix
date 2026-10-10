import type { TenantTreeNode } from '../../api/types';

export interface TreeRow {
  node: TenantTreeNode;
  /** 1-based level for `aria-level`, relative to the shallowest node of the response. */
  level: number;
  /** Position among the shown siblings (`aria-posinset`) and their number (`aria-setsize`). */
  posInSet: number;
  setSize: number;
  /** Children present in the response (not `hasChildren`: a truncated tree may omit them). */
  expandable: boolean;
  expanded: boolean;
  parentId: string | null;
}

/** Ids that start expanded: the path stubs and the shallowest visible level, i.e. two levels open. */
export function defaultExpanded(items: TenantTreeNode[]): Set<string> {
  const visibleDepths = items.filter((n) => n.visible).map((n) => n.depth);
  const top = visibleDepths.length ? Math.min(...visibleDepths) : 0;
  return new Set(items.filter((n) => !n.visible || n.depth <= top).map((n) => n.id));
}

export function matches(node: TenantTreeNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${node.name} ${node.slug}`.toLowerCase().includes(q);
}

/**
 * The rows to render. The API returns parents before their children (depth first), so one pass
 * decides what is shown. A search keeps the matches and their ancestors and expands the path to
 * them (the stored expand state is left alone and applies again when the search is cleared).
 */
export function visibleRows(
  items: TenantTreeNode[],
  expanded: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  const ids = new Set(items.map((n) => n.id));
  const childrenOf = new Map<string, TenantTreeNode[]>();
  for (const n of items) {
    if (n.parentId && ids.has(n.parentId)) {
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n);
      childrenOf.set(n.parentId, list);
    }
  }
  const searching = query.trim() !== '';
  // Nodes that stay: matches plus all their ancestors.
  const keep = new Set<string>();
  if (searching) {
    const byId = new Map(items.map((n) => [n.id, n]));
    for (const n of items) {
      if (!n.visible || !matches(n, query)) continue;
      for (let cur: TenantTreeNode | undefined = n; cur;) {
        if (keep.has(cur.id)) break;
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
  }
  const top = items.length ? Math.min(...items.map((n) => n.depth)) : 0;
  const rows: TreeRow[] = [];
  const rowById = new Map<string, TreeRow>();
  const shownSiblings = new Map<string | null, number>();
  for (const n of items) {
    if (searching && !keep.has(n.id)) continue;
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    if (parent !== null) {
      const parentRow = rowById.get(parent);
      // a child needs a shown, open parent (while searching the kept path is always open)
      if (!parentRow || (!searching && !parentRow.expanded)) continue;
    }
    const kids = childrenOf.get(n.id) ?? [];
    const open = searching ? kids.some((k) => keep.has(k.id)) : expanded.has(n.id);
    const position = (shownSiblings.get(parent) ?? 0) + 1;
    shownSiblings.set(parent, position);
    const row: TreeRow = {
      node: n,
      level: n.depth - top + 1,
      posInSet: position,
      setSize: 0,
      expandable: kids.length > 0,
      expanded: kids.length > 0 && open,
      parentId: parent,
    };
    rows.push(row);
    rowById.set(n.id, row);
  }
  for (const r of rows) r.setSize = shownSiblings.get(r.parentId) ?? 1;
  return rows;
}

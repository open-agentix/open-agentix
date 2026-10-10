import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { tenantTreeQuery } from '../../api/queries';
import type { TenantTreeNode } from '../../api/types';
import { meQuery } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { PHONE_QUERY } from '../../components/ResponsiveList';
import { ListSkeleton } from '../../components/Skeleton';
import { TenantTile, useActiveTenant } from '../../components/Tenant';
import { useToast } from '../../components/toast';
import {
  Badge,
  EmptyState,
  ErrorState,
  Meter,
  PageHeader,
  Section,
  TextField,
} from '../../components/ui';
import { useI18n, type TKey } from '../../i18n/i18n';
import { activeTenant } from '../../lib/activeTenant';
import { useDebounced, useDocumentTitle, useMediaQuery } from '../../lib/hooks';
import { pushRecent } from './recent';
import { defaultExpanded, matches, visibleRows, type TreeRow } from './treeRows';

const route = getRouteApi('/_app/tenants');
const SEARCH_DEBOUNCE_MS = 250;

/** API role names (`admin`, `agent-engineer`, ...) to the role labels of the console. */
const ROLE_KEYS: Record<string, TKey> = {
  admin: 'tenancy.roles.tenantAdmin',
  'agent-engineer': 'tenancy.roles.agentEngineer',
  integrator: 'tenancy.roles.integrator',
  operator: 'tenancy.roles.operator',
  auditor: 'tenancy.roles.auditor',
  viewer: 'tenancy.roles.viewer',
  pentest: 'tenancy.roles.pentest',
};

/** One tenant row's view of what the principal may do with it. */
type SwitchState = 'current' | 'allowed' | 'denied';

export function TenantsPage() {
  const { t, locale } = useI18n();
  useDocumentTitle(t('tenancy.overview.title'));
  const toast = useToast();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const tree = useQuery(tenantTreeQuery);
  const { data: me } = useQuery(meQuery);
  const acting = useActiveTenant();
  const phone = useMediaQuery(PHONE_QUERY);
  const gridId = useId();
  const noteId = useId();

  // Search text: local state for typing, debounced into the URL (replace).
  const [input, setInput] = useState(search.q ?? '');
  const debounced = useDebounced(input, SEARCH_DEBOUNCE_MS);
  const pushed = useRef(search.q ?? '');
  useEffect(() => {
    const next = debounced.trim();
    if (next === pushed.current) return;
    pushed.current = next;
    void navigate({ search: { q: next || undefined }, replace: true });
  }, [debounced, navigate]);
  // back/forward changes the URL: flow it back into the field
  useEffect(() => {
    const q = search.q ?? '';
    if (q !== pushed.current) {
      pushed.current = q;
      setInput(q);
    }
  }, [search.q]);
  const query = (search.q ?? '').trim();

  const items = useMemo(() => tree.data?.items ?? [], [tree.data]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const open = useMemo(() => expanded ?? defaultExpanded(items), [expanded, items]);
  const rows = useMemo(() => visibleRows(items, open, query), [items, open, query]);

  const toggle = useCallback(
    (id: string, to?: boolean) =>
      setExpanded((prev) => {
        const next = new Set(prev ?? defaultExpanded(items));
        const want = to ?? !next.has(id);
        if (want) next.add(id);
        else next.delete(id);
        return next;
      }),
    [items],
  );

  const homeId = me?.homeTenant.id;
  const switchState = (n: TenantTreeNode): SwitchState => {
    if (!n.visible) return 'denied';
    if (acting?.id === n.id) return 'current';
    return me?.platformAdmin || n.id === homeId ? 'allowed' : 'denied';
  };

  const [message, setMessage] = useState('');
  const doSwitch = (n: TenantTreeNode) => {
    if (me?.user.id) pushRecent(me.user.id, n.id);
    activeTenant.set({ id: n.id, slug: n.slug, name: n.name });
    toast.info(t('tenancy.switcher.switched', { tenant: n.name }));
    setMessage(t('tenancy.switcher.switched', { tenant: n.name }));
  };
  const trySwitch = (n: TenantTreeNode) => {
    const state = switchState(n);
    if (state === 'allowed') doSwitch(n);
    else if (state === 'denied')
      setMessage(
        n.visible ? t('tenancy.overview.cannotSwitch') : t('tenancy.overview.pathOnlyHint'),
      );
  };

  const numbers = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact' }), [locale]);
  const money = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }),
    [locale],
  );
  const ctx: Ctx = { t, numbers, money, platformAdmin: !!me?.platformAdmin };

  const visibleNodes = items.filter((n) => n.visible);
  const onlyOwn = !!tree.data && visibleNodes.length === 1 && !me?.platformAdmin;

  let body: ReactNode;
  if (tree.isPending) body = <ListSkeleton rows={4} />;
  else if (tree.isError)
    body = <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;
  else if (items.length === 0)
    body = <EmptyState icon="tenants" title={t('tenancy.overview.empty')} />;
  else if (rows.length === 0)
    body = <EmptyState icon="search" title={t('tenancy.overview.noMatch', { query })} />;
  else if (phone)
    body = (
      <ul className="tenant-cards" aria-label={t('tenancy.overview.grid')}>
        {rows.map((r) => (
          <TenantCard
            key={r.node.id}
            row={r}
            ctx={ctx}
            state={switchState(r.node)}
            onToggle={() => toggle(r.node.id)}
            onSwitch={() => trySwitch(r.node)}
          />
        ))}
      </ul>
    );
  else
    body = (
      <TenantGrid
        id={gridId}
        rows={rows}
        ctx={ctx}
        searching={query !== ''}
        stateOf={switchState}
        onToggle={toggle}
        onExpandSiblings={(parentId) =>
          setExpanded((prev) => {
            const next = new Set(prev ?? defaultExpanded(items));
            for (const n of items) if (n.parentId === parentId) next.add(n.id);
            return next;
          })
        }
        onSwitch={trySwitch}
      />
    );

  return (
    <>
      <PageHeader
        title={t('tenancy.overview.title')}
        description={t('tenancy.overview.description')}
      />
      <Section>
        <div className="tenants-toolbar">
          <TextField
            label={t('tenancy.overview.search')}
            type="search"
            value={input}
            placeholder={t('tenancy.overview.searchPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        {tree.data?.truncated ? (
          <div className="notice notice-warning" role="status">
            <Icon name="alert" size={16} />
            <span>{t('tenancy.overview.truncated', { count: items.length })}</span>
          </div>
        ) : null}
        {onlyOwn ? (
          <div className="notice notice-info" id={noteId} role="note">
            <Icon name="info" size={16} />
            <span>
              <strong>{t('tenancy.overview.onlyOwn')}</strong> {t('tenancy.overview.onlyOwnDetail')}
            </span>
          </div>
        ) : null}
        {body}
        {tree.data && rows.length > 0 && !phone ? (
          <p className="muted tenants-hint">{t('tenancy.overview.hint')}</p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {message ||
            (tree.data
              ? query
                ? t('tenancy.overview.matches', {
                    count: visibleNodes.filter((n) => matches(n, query)).length,
                  })
                : t('tenancy.overview.loaded', { count: visibleNodes.length })
              : '')}
        </p>
      </Section>
    </>
  );
}

interface Ctx {
  t: ReturnType<typeof useI18n>['t'];
  numbers: Intl.NumberFormat;
  money: Intl.NumberFormat;
  platformAdmin: boolean;
}

/* ------------------------------------------------------------------ cells */

/** `–` for a value the caller may not read, with the reason as text; never a 0. */
function NotPermitted({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{ctx.t('tenancy.overview.notPermitted')}</span>
    </>
  );
}

function Count({
  ctx,
  own,
  sub,
  subtreeWanted,
}: {
  ctx: Ctx;
  own: number | null | undefined;
  sub?: number | null | undefined;
  subtreeWanted: boolean;
}) {
  if (own === null || own === undefined) return <NotPermitted ctx={ctx} />;
  const showSub = subtreeWanted && sub !== null && sub !== undefined && sub !== own;
  const visible = showSub
    ? `${ctx.numbers.format(own)} (${ctx.numbers.format(sub)})`
    : ctx.numbers.format(own);
  return (
    <>
      <span aria-hidden="true">{visible}</span>
      <span className="sr-only">
        {showSub ? ctx.t('tenancy.overview.subtree', { own, sub }) : String(own)}
      </span>
    </>
  );
}

function Spend({ node, ctx }: { node: TenantTreeNode; ctx: Ctx }) {
  const c = node.counts;
  if (!c || c.spendMonthUsd === null) return <NotPermitted ctx={ctx} />;
  const spent = ctx.money.format(c.spendMonthUsd);
  const capped = c.capUsd !== null;
  const sub =
    c.spendMonthSubtreeUsd !== null &&
    c.spendMonthSubtreeUsd !== c.spendMonthUsd &&
    node.hasChildren
      ? ` (${ctx.money.format(c.spendMonthSubtreeUsd)})`
      : '';
  const cap = capped ? ctx.money.format(c.capUsd as number) : null;
  return (
    <span className="tenant-spend">
      <span aria-hidden="true">
        {spent}
        {sub} / {cap ?? '–'}
      </span>
      <span className="sr-only">
        {cap
          ? ctx.t('tenancy.overview.spendOf', { spent, cap })
          : `${spent}. ${ctx.t('tenancy.overview.noCap')}`}
      </span>
      {capped && (c.capUsd as number) > 0 ? (
        <Meter
          value={c.spendMonthUsd}
          max={c.capUsd as number}
          label={ctx.t('tenancy.overview.spendLabel', { spent, cap: cap as string })}
        />
      ) : null}
    </span>
  );
}

function Pending({ node, ctx }: { node: TenantTreeNode; ctx: Ctx }) {
  const n = node.counts?.pendingApprovals;
  if (n === null || n === undefined) return <NotPermitted ctx={ctx} />;
  if (n === 0) return <span>0</span>;
  return (
    <Badge tone="warning">
      <span aria-hidden="true">{ctx.numbers.format(n)}</span>
      <span className="sr-only">{ctx.t('tenancy.overview.pendingBadge', { count: n })}</span>
    </Badge>
  );
}

function Roles({ node, ctx }: { node: TenantTreeNode; ctx: Ctx }) {
  if (!node.visible) return <NotPermitted ctx={ctx} />;
  const label = (r: string) => (ROLE_KEYS[r] ? ctx.t(ROLE_KEYS[r]) : r);
  const out: ReactNode[] = [];
  if (ctx.platformAdmin)
    out.push(
      <span key="pa" className="role-badge" title={ctx.t('tenancy.overview.platformAdminHint')}>
        <Badge tone="accent">{ctx.t('tenancy.roles.platformAdmin')}</Badge>
        <span className="sr-only">{ctx.t('tenancy.overview.platformAdminHint')}</span>
      </span>,
    );
  for (const r of node.myRoles)
    out.push(
      <span key={`d-${r}`} className="role-badge" title={ctx.t('tenancy.overview.directHint')}>
        <Badge>{label(r)}</Badge>
        <span className="sr-only">{ctx.t('tenancy.overview.directHint')}</span>
      </span>,
    );
  for (const r of node.inheritedRoles)
    out.push(
      <span key={`i-${r}`} className="role-badge" title={ctx.t('tenancy.overview.inheritedHint')}>
        <Badge tone="info">
          {label(r)} <span className="role-inherited">({ctx.t('tenancy.overview.inherited')})</span>
        </Badge>
        <span className="sr-only">{ctx.t('tenancy.overview.inheritedHint')}</span>
      </span>,
    );
  if (out.length === 0) return <span className="muted">{ctx.t('tenancy.overview.noRole')}</span>;
  return <span className="role-badges">{out}</span>;
}

function NameCell({ node, ctx }: { node: TenantTreeNode; ctx: Ctx }) {
  return (
    <>
      <TenantTile tenant={node} small />
      <span className="tenant-row-text">
        <span className="tenant-row-name">{node.name}</span>
        <span className="tenant-row-slug muted">{node.slug}</span>
      </span>
      {!node.visible ? (
        <span title={ctx.t('tenancy.overview.pathOnlyHint')}>
          <Badge>{ctx.t('tenancy.overview.pathOnly')}</Badge>
          <span className="sr-only">{ctx.t('tenancy.overview.pathOnlyHint')}</span>
        </span>
      ) : null}
      {node.visible && node.status === 'blocked' ? (
        <Badge tone="danger">
          <Icon name="alert" size={13} />
          {ctx.t('tenancy.overview.blocked')}
        </Badge>
      ) : null}
    </>
  );
}

function SwitchAction({
  node,
  state,
  ctx,
  onSwitch,
  tabIndex,
  showReason = false,
}: {
  node: TenantTreeNode;
  state: SwitchState;
  ctx: Ctx;
  onSwitch: () => void;
  tabIndex?: number;
  showReason?: boolean;
}) {
  const reasonId = useId();
  if (state === 'current')
    return (
      <span className="tenant-current">
        <Icon name="check" size={14} />
        {ctx.t('tenancy.overview.current')}
      </span>
    );
  const denied = state === 'denied';
  const reason = node.visible
    ? ctx.t('tenancy.overview.cannotSwitch')
    : ctx.t('tenancy.overview.pathOnlyHint');
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm tenant-switch-btn"
        tabIndex={tabIndex}
        aria-disabled={denied || undefined}
        aria-describedby={denied ? reasonId : undefined}
        aria-label={ctx.t('tenancy.overview.switchToNamed', { tenant: node.name })}
        title={denied ? reason : ctx.t('tenancy.overview.switchTo')}
        onClick={onSwitch}
      >
        {ctx.t('tenancy.overview.switchTo')}
      </button>
      {denied ? (
        <span id={reasonId} className={showReason ? 'tenant-reason muted' : 'sr-only'}>
          {reason}
        </span>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- treegrid */

function TenantGrid({
  id,
  rows,
  ctx,
  searching,
  stateOf,
  onToggle,
  onExpandSiblings,
  onSwitch,
}: {
  id: string;
  rows: TreeRow[];
  ctx: Ctx;
  searching: boolean;
  stateOf: (n: TenantTreeNode) => SwitchState;
  onToggle: (id: string, to?: boolean) => void;
  onExpandSiblings: (parentId: string | null) => void;
  onSwitch: (n: TenantTreeNode) => void;
}) {
  const { t } = ctx;
  const gridRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const focusAfter = useRef<string | null>(null);
  const current = rows.find((r) => r.node.id === activeId) ?? rows[0];

  // Move DOM focus after the render that made the target row available.
  useEffect(() => {
    if (!focusAfter.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(focusAfter.current)}"]`,
    );
    focusAfter.current = null;
    el?.focus();
  });

  const go = (target: TreeRow | undefined) => {
    if (!target) return;
    setActiveId(target.node.id);
    focusAfter.current = target.node.id;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    // Keys typed inside the row's button keep their normal meaning.
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    const stop = () => e.preventDefault();
    switch (e.key) {
      case 'ArrowDown':
        stop();
        go(rows[Math.min(index + 1, rows.length - 1)]);
        break;
      case 'ArrowUp':
        stop();
        go(rows[Math.max(index - 1, 0)]);
        break;
      case 'Home':
        stop();
        go(rows[0]);
        break;
      case 'End':
        stop();
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        stop();
        if (row.expandable && !row.expanded) onToggle(row.node.id, true);
        else if (row.expandable) go(rows[index + 1]);
        break;
      case 'ArrowLeft':
        stop();
        if (row.expandable && row.expanded && !searching) onToggle(row.node.id, false);
        else go(rows.find((r) => r.node.id === row.parentId));
        break;
      case '+':
        stop();
        if (row.expandable) onToggle(row.node.id, true);
        break;
      case '-':
        stop();
        if (row.expandable && !searching) onToggle(row.node.id, false);
        break;
      case '*':
        stop();
        onExpandSiblings(row.parentId);
        break;
      case 'Enter':
        stop();
        onSwitch(row.node);
        break;
    }
  };

  return (
    <div
      id={id}
      ref={gridRef}
      className="tenant-grid"
      role="treegrid"
      aria-label={t('tenancy.overview.grid')}
      aria-rowcount={rows.length + 1}
    >
      <div role="row" className="tenant-grid-row tenant-grid-head">
        <div role="columnheader">{t('tenancy.overview.col.tenant')}</div>
        <div role="columnheader" className="num">
          {t('tenancy.overview.col.agents')}
        </div>
        <div role="columnheader" className="num">
          {t('tenancy.overview.col.runs')}
        </div>
        <div role="columnheader">{t('tenancy.overview.col.spend')}</div>
        <div role="columnheader" className="num">
          {t('tenancy.overview.col.pending')}
        </div>
        <div role="columnheader">{t('tenancy.overview.col.roles')}</div>
        <div role="columnheader">{t('tenancy.overview.col.action')}</div>
      </div>
      {rows.map((r, index) => {
        const n = r.node;
        const isActive = current?.node.id === n.id;
        const state = stateOf(n);
        const subtree = n.hasChildren;
        return (
          <div
            key={n.id}
            role="row"
            className={`tenant-grid-row${n.visible ? '' : ' is-stub'}${state === 'current' ? ' is-current' : ''}`}
            data-row-id={n.id}
            tabIndex={isActive ? 0 : -1}
            aria-level={r.level}
            aria-posinset={r.posInSet}
            aria-setsize={r.setSize}
            aria-expanded={r.expandable ? r.expanded : undefined}
            aria-current={state === 'current' ? 'true' : undefined}
            aria-rowindex={index + 2}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setActiveId(n.id);
            }}
            onKeyDown={(e) => onKeyDown(e, r, index)}
          >
            <div role="rowheader" className="tenant-name-cell" style={indent(r.level)}>
              {r.expandable ? (
                <button
                  type="button"
                  className="icon-btn tenant-toggle"
                  tabIndex={-1}
                  disabled={searching}
                  aria-label={t(
                    r.expanded ? 'tenancy.overview.collapse' : 'tenancy.overview.expand',
                    {
                      tenant: n.name,
                    },
                  )}
                  onClick={() => onToggle(n.id)}
                >
                  <Icon name={r.expanded ? 'chevronDown' : 'chevronRight'} size={14} />
                </button>
              ) : (
                <span className="tenant-toggle-spacer" aria-hidden="true" />
              )}
              <NameCell node={n} ctx={ctx} />
            </div>
            <div role="gridcell" className="num">
              {n.visible ? (
                <Count
                  ctx={ctx}
                  own={n.counts?.agents}
                  sub={n.counts?.agentsSubtree}
                  subtreeWanted={subtree}
                />
              ) : (
                <NotPermitted ctx={ctx} />
              )}
            </div>
            <div role="gridcell" className="num">
              {n.visible ? (
                <Count ctx={ctx} own={n.counts?.runs30d} subtreeWanted={false} />
              ) : (
                <NotPermitted ctx={ctx} />
              )}
            </div>
            <div role="gridcell">
              {n.visible ? <Spend node={n} ctx={ctx} /> : <NotPermitted ctx={ctx} />}
            </div>
            <div role="gridcell" className="num">
              {n.visible ? <Pending node={n} ctx={ctx} /> : <NotPermitted ctx={ctx} />}
            </div>
            <div role="gridcell">
              <Roles node={n} ctx={ctx} />
            </div>
            <div role="gridcell">
              <SwitchAction
                node={n}
                state={state}
                ctx={ctx}
                tabIndex={isActive ? 0 : -1}
                onSwitch={() => onSwitch(n)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const indent = (level: number): CSSProperties => ({ '--level': level - 1 }) as CSSProperties;

/* ------------------------------------------------------------- phone cards */

function TenantCard({
  row,
  ctx,
  state,
  onToggle,
  onSwitch,
}: {
  row: TreeRow;
  ctx: Ctx;
  state: SwitchState;
  onToggle: () => void;
  onSwitch: () => void;
}) {
  const n = row.node;
  const { t } = ctx;
  return (
    <li
      className={`tenant-card${n.visible ? '' : ' is-stub'}${state === 'current' ? ' is-current' : ''}`}
      style={indent(row.level)}
      data-level={row.level}
      aria-current={state === 'current' ? 'true' : undefined}
    >
      <div className="tenant-card-head">
        {row.expandable ? (
          <button
            type="button"
            className="icon-btn tenant-toggle"
            aria-expanded={row.expanded}
            aria-label={t(row.expanded ? 'tenancy.overview.collapse' : 'tenancy.overview.expand', {
              tenant: n.name,
            })}
            onClick={onToggle}
          >
            <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>
        ) : null}
        <NameCell node={n} ctx={ctx} />
        <span className="tenant-level muted">
          {t('tenancy.overview.level', { level: row.level })}
        </span>
      </div>
      {n.visible ? (
        <dl className="tenant-card-metrics">
          <div>
            <dt>{t('tenancy.overview.col.agents')}</dt>
            <dd>
              <Count
                ctx={ctx}
                own={n.counts?.agents}
                sub={n.counts?.agentsSubtree}
                subtreeWanted={n.hasChildren}
              />
            </dd>
          </div>
          <div>
            <dt>{t('tenancy.overview.col.runs')}</dt>
            <dd>
              <Count ctx={ctx} own={n.counts?.runs30d} subtreeWanted={false} />
            </dd>
          </div>
          <div>
            <dt>{t('tenancy.overview.col.pending')}</dt>
            <dd>
              <Pending node={n} ctx={ctx} />
            </dd>
          </div>
          <div className="tenant-card-spend">
            <dt>{t('tenancy.overview.col.spend')}</dt>
            <dd>
              <Spend node={n} ctx={ctx} />
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="tenant-card-foot">
        <Roles node={n} ctx={ctx} />
        <SwitchAction node={n} state={state} ctx={ctx} onSwitch={onSwitch} showReason />
      </div>
    </li>
  );
}

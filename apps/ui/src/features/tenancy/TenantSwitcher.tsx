import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { meQuery } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { TenantTile, type TenantRef } from '../../components/Tenant';
import { useToast } from '../../components/toast';
import { useI18n } from '../../i18n/i18n';
import { activeTenant } from '../../lib/activeTenant';
import { useMediaQuery } from '../../lib/hooks';
import { pushRecent, readRecent } from './recent';
import { useSwitchableTenants, type SwitchableTenant } from './useSwitchableTenants';

interface Option {
  key: string;
  group: 'recent' | 'all';
  tenant: SwitchableTenant;
}

const byName = (a: SwitchableTenant, b: SwitchableTenant) =>
  a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);

/** Detail pages show an item of the tenant that is being left; the list page survives a switch. */
function listPathOf(pathname: string): '/agents' | '/runs' | null {
  const m = /^\/(agents|runs)\/[^/]+/.exec(pathname);
  return m ? (`/${m[1]}` as '/agents' | '/runs') : null;
}

/**
 * Tenant switcher: a button (tile, name, caret) that opens a popover on desktop and a bottom
 * sheet on phones. The popover holds a search combobox over a listbox with the recent tenants and
 * all tenants the API lists. Selecting one makes it the acting tenant of every API call
 * (`X-OAX-Tenant`, see `activeTenant`); `useTenantSync` then drops all cached data.
 *
 * The list is flat and alphabetical: `GET /v1/tenants` returns neither a parent nor a path yet,
 * so grouping by organisation and the tree of the design wait for the tenant-tree API slices.
 */
export function TenantSwitcher({
  placement,
  tenant,
}: {
  placement: 'top' | 'side';
  tenant: TenantRef;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useQuery(meQuery);
  const tenants = useSwitchableTenants();
  const phone = useMediaQuery('(max-width: 600px)');
  const popId = useId();
  const listId = useId();
  const recentLabelId = useId();
  const allLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const userId = me?.user.id ?? '';
  const homeId = me?.user.tenantId;

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...tenants].sort(byName);
    const out: Option[] = [];
    if (!q) {
      for (const id of recent) {
        const found = tenants.find((x) => x.id === id);
        if (found) out.push({ key: `r-${found.id}`, group: 'recent', tenant: found });
      }
    }
    for (const x of sorted) {
      if (q && !`${x.name} ${x.slug}`.toLowerCase().includes(q)) continue;
      out.push({ key: `a-${x.id}`, group: 'all', tenant: x });
    }
    return out;
  }, [tenants, recent, query]);

  const openPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setAnchor({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)),
      });
    setRecent(userId ? readRecent(userId) : []);
    setQuery('');
    setOpen(true);
  };

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Start on the current tenant; keep the highlight inside the (filtered) list.
  useEffect(() => {
    if (!open) return;
    const at = options.findIndex((o) => o.tenant.id === tenant.id);
    setHighlight(query.trim() ? 0 : Math.max(0, at));
  }, [open, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const choose = (target: SwitchableTenant) => {
    setOpen(false);
    if (target.id === tenant.id) {
      triggerRef.current?.focus();
      return;
    }
    if (userId) setRecent(pushRecent(userId, target.id));
    activeTenant.set({ id: target.id, slug: target.slug, name: target.name });
    toast.info(t('tenancy.switcher.switched', { tenant: target.name }));
    // An item of the previous tenant (agent, run) does not exist in the new one.
    const list = listPathOf(pathname);
    if (list) void navigate({ to: list });
    window.setTimeout(() => {
      const h1 = document.querySelector<HTMLElement>('main h1');
      const el = h1 ?? triggerRef.current;
      if (h1) h1.tabIndex = -1;
      el?.focus();
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlight((h) => (last < 0 ? 0 : h >= last ? 0 : h + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => (last < 0 ? 0 : h <= 0 ? last : h - 1));
        break;
      case 'Home':
        e.preventDefault();
        setHighlight(0);
        break;
      case 'End':
        e.preventDefault();
        setHighlight(Math.max(0, last));
        break;
      case 'Enter': {
        e.preventDefault();
        const o = options[highlight];
        if (o) choose(o.tenant);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const active = options[highlight];
  const optionId = (o: Option) => `${listId}-${o.key}`;
  const groups: { id: string; label: string; items: Option[] }[] = [
    {
      id: recentLabelId,
      label: t('tenancy.switcher.recent'),
      items: options.filter((o) => o.group === 'recent'),
    },
    {
      id: allLabelId,
      label: t('tenancy.switcher.all'),
      items: options.filter((o) => o.group === 'all'),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div ref={rootRef} className={`tenant-switcher tenant-badge-${placement}`}>
      <button
        ref={triggerRef}
        type="button"
        className="tenant-switcher-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={t('tenancy.switcher.trigger', { tenant: tenant.name })}
        title={t('tenancy.switchTenant')}
        onClick={() => (open ? close(false) : openPopover())}
      >
        <TenantTile tenant={tenant} />
        <span className="tenant-name">{tenant.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div
          id={popId}
          role="dialog"
          aria-label={t('tenancy.switcher.title')}
          className="tenant-popover"
          style={phone || !anchor ? undefined : { top: anchor.top, left: anchor.left }}
        >
          <div className="tenant-popover-head">
            <span className="tenant-popover-grip" aria-hidden="true" />
            <button
              type="button"
              className="icon-btn tenant-popover-close"
              onClick={() => close()}
              aria-label={t('common.close')}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="tenant-search">
            <Icon name="search" size={16} />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={t('tenancy.switcher.search')}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active ? optionId(active) : undefined}
              placeholder={t('tenancy.switcher.placeholder')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('tenancy.switcher.title')}
            className="tenant-list"
          >
            {groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={g.id}>
                <p id={g.id} className="tenant-group">
                  {g.label}
                </p>
                {g.items.map((o) => {
                  const current = o.tenant.id === tenant.id;
                  return (
                    <div
                      key={o.key}
                      id={optionId(o)}
                      role="option"
                      aria-selected={active?.key === o.key}
                      aria-current={current ? 'true' : undefined}
                      className={`tenant-option${active?.key === o.key ? ' is-active' : ''}`}
                      onPointerMove={() => {
                        const idx = options.findIndex((x) => x.key === o.key);
                        if (idx !== highlight) setHighlight(idx);
                      }}
                      onClick={() => choose(o.tenant)}
                    >
                      <TenantTile tenant={o.tenant} small />
                      <span className="tenant-option-text">
                        <span className="tenant-option-name">{o.tenant.name}</span>
                        <span className="tenant-option-slug">{o.tenant.slug}</span>
                      </span>
                      {o.tenant.id === homeId ? (
                        <span className="tenant-option-tag">{t('tenancy.switcher.home')}</span>
                      ) : null}
                      {current ? (
                        <>
                          <Icon name="check" size={16} />
                          <span className="sr-only">{t('tenancy.switcher.current')}</span>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {options.length === 0 ? (
              <p className="tenant-empty muted">
                {t('tenancy.switcher.empty', { query: query.trim() })}
              </p>
            ) : null}
          </div>
          <p className="tenant-hint muted">{t('tenancy.switcher.hint')}</p>
          <p className="sr-only" role="status" aria-live="polite">
            {t('tenancy.switcher.results', { count: options.length })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

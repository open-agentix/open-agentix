import type { Permission } from '../auth/auth';
import type { IconName } from '../components/Icon';
import type { TKey } from '../i18n/i18n';

export interface NavItem {
  to:
    | '/'
    | '/agents'
    | '/wizard'
    | '/events'
    | '/runs'
    | '/connections'
    | '/policies'
    | '/audit'
    | '/costs'
    | '/users'
    | '/tokens'
    | '/settings';
  label: TKey;
  icon: IconName;
  perm?: Permission;
}

export interface NavGroup {
  label: TKey;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'nav.groups.overview',
    items: [{ to: '/', label: 'nav.dashboard', icon: 'dashboard' }],
  },
  {
    label: 'nav.groups.build',
    items: [
      { to: '/wizard', label: 'nav.wizard', icon: 'wizard', perm: 'agents:read' },
      { to: '/agents', label: 'nav.agents', icon: 'agents', perm: 'agents:read' },
      {
        to: '/connections',
        label: 'nav.connections',
        icon: 'connections',
        perm: 'connections:read',
      },
      { to: '/events', label: 'nav.events', icon: 'events', perm: 'sources:read' },
    ],
  },
  {
    label: 'nav.groups.operate',
    items: [
      { to: '/runs', label: 'nav.runs', icon: 'runs', perm: 'runs:read' },
      { to: '/costs', label: 'nav.costs', icon: 'costs', perm: 'costs:read' },
    ],
  },
  {
    label: 'nav.groups.govern',
    items: [
      { to: '/policies', label: 'nav.policies', icon: 'policies', perm: 'policies:read' },
      { to: '/audit', label: 'nav.audit', icon: 'audit', perm: 'audit:read' },
      { to: '/users', label: 'nav.users', icon: 'users', perm: 'users:read' },
      { to: '/tokens', label: 'nav.tokens', icon: 'tokens', perm: 'tokens:read' },
      { to: '/settings', label: 'nav.settings', icon: 'settings' },
    ],
  },
];

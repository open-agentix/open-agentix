import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { ApiError } from './api/client';
import {
  agentQuery,
  agentsQuery,
  agentVersionsQuery,
  approvalsQuery,
  auditQuery,
  connectionsQuery,
  eventSourcesQuery,
  policiesQuery,
  runQuery,
  runsQuery,
  runStepsQuery,
  teamsQuery,
  tokensQuery,
  usersQuery,
} from './api/queries';
import { RUN_STATUSES, type CostGroupBy, type RunStatus } from './api/types';
import { meQuery, settingsQuery } from './auth/auth';
import { session } from './auth/session';
import { ErrorState, Loading } from './components/ui';
import { AppShell } from './layout/AppShell';
import { NotFound } from './layout/NotFound';

export interface RouterContext {
  queryClient: QueryClient;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { redirect?: string; expired?: boolean } => ({
    redirect: str(s.redirect),
    expired: s.expired === true || s.expired === 'true' ? true : undefined,
  }),
  component: lazyRouteComponent(() => import('./features/auth/LoginPage'), 'LoginPage'),
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: lazyRouteComponent(() => import('./features/auth/OidcCallback'), 'OidcCallback'),
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: async ({ context, location }) => {
    if (!session.token()) {
      throw redirect({ to: '/login', search: { redirect: location.href, expired: undefined } });
    }
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href, expired: true } });
      }
      throw e;
    }
    void context.queryClient.prefetchQuery(settingsQuery);
  },
  component: AppShell,
});

const child = <P extends string>(path: P) => ({ getParentRoute: () => appRoute, path });

const dashboardRoute = createRoute({
  ...child('/'),
  component: lazyRouteComponent(
    () => import('./features/dashboard/DashboardPage'),
    'DashboardPage',
  ),
});

const agentsRoute = createRoute({
  ...child('/agents'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(agentsQuery),
  component: lazyRouteComponent(() => import('./features/agents/AgentsPage'), 'AgentsPage'),
});

const agentNewRoute = createRoute({
  ...child('/agents/new'),
  component: lazyRouteComponent(() => import('./features/agents/NewAgentPage'), 'NewAgentPage'),
});

export const AGENT_TABS = ['overview', 'editor', 'versions', 'diff', 'test'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

const agentDetailRoute = createRoute({
  ...child('/agents/$agentId'),
  validateSearch: (s: Record<string, unknown>): { tab?: AgentTab; from?: string; to?: string } => ({
    tab: (AGENT_TABS as readonly string[]).includes(String(s.tab))
      ? (s.tab as AgentTab)
      : undefined,
    from: str(s.from),
    to: str(s.to),
  }),
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(agentQuery(params.agentId));
    void context.queryClient.prefetchQuery(agentVersionsQuery(params.agentId));
  },
  component: lazyRouteComponent(
    () => import('./features/agents/AgentDetailPage'),
    'AgentDetailPage',
  ),
});

const wizardRoute = createRoute({
  ...child('/wizard'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(connectionsQuery),
  component: lazyRouteComponent(() => import('./features/wizard/WizardPage'), 'WizardPage'),
});

const eventsRoute = createRoute({
  ...child('/events'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(eventSourcesQuery),
  component: lazyRouteComponent(() => import('./features/events/EventsPage'), 'EventsPage'),
});

const runsRoute = createRoute({
  ...child('/runs'),
  validateSearch: (s: Record<string, unknown>): { status?: RunStatus; agentId?: string } => ({
    status: (RUN_STATUSES as readonly string[]).includes(String(s.status))
      ? (s.status as RunStatus)
      : undefined,
    agentId: str(s.agentId),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(runsQuery(deps));
    void context.queryClient.prefetchQuery(approvalsQuery());
  },
  component: lazyRouteComponent(() => import('./features/runs/RunsPage'), 'RunsPage'),
});

const runDetailRoute = createRoute({
  ...child('/runs/$runId'),
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(runQuery(params.runId));
    void context.queryClient.prefetchQuery(runStepsQuery(params.runId));
  },
  component: lazyRouteComponent(() => import('./features/runs/RunDetailPage'), 'RunDetailPage'),
});

const connectionsRoute = createRoute({
  ...child('/connections'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(connectionsQuery),
  component: lazyRouteComponent(
    () => import('./features/connections/ConnectionsPage'),
    'ConnectionsPage',
  ),
});

const policiesRoute = createRoute({
  ...child('/policies'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(policiesQuery),
  component: lazyRouteComponent(() => import('./features/policies/PoliciesPage'), 'PoliciesPage'),
});

const auditRoute = createRoute({
  ...child('/audit'),
  validateSearch: (s: Record<string, unknown>): { runId?: string; action?: string } => ({
    runId: str(s.runId),
    action: str(s.action),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => void context.queryClient.prefetchInfiniteQuery(auditQuery(deps)),
  component: lazyRouteComponent(() => import('./features/audit/AuditPage'), 'AuditPage'),
});

const COST_GROUPS: readonly CostGroupBy[] = ['agent', 'team', 'month', 'run', 'provider', 'model'];

const costsRoute = createRoute({
  ...child('/costs'),
  validateSearch: (s: Record<string, unknown>): { groupBy?: CostGroupBy } => ({
    groupBy: COST_GROUPS.includes(s.groupBy as CostGroupBy)
      ? (s.groupBy as CostGroupBy)
      : undefined,
  }),
  component: lazyRouteComponent(() => import('./features/costs/CostsPage'), 'CostsPage'),
});

export const USER_TABS = ['users', 'teams', 'matrix'] as const;
export type UserTab = (typeof USER_TABS)[number];

const usersRoute = createRoute({
  ...child('/users'),
  validateSearch: (s: Record<string, unknown>): { tab?: UserTab } => ({
    tab: (USER_TABS as readonly string[]).includes(String(s.tab)) ? (s.tab as UserTab) : undefined,
  }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(usersQuery);
    void context.queryClient.prefetchQuery(teamsQuery);
  },
  component: lazyRouteComponent(() => import('./features/users/UsersPage'), 'UsersPage'),
});

const tokensRoute = createRoute({
  ...child('/tokens'),
  loader: ({ context }) => void context.queryClient.prefetchQuery(tokensQuery(false)),
  component: lazyRouteComponent(() => import('./features/tokens/TokensPage'), 'TokensPage'),
});

const settingsRoute = createRoute({
  ...child('/settings'),
  component: lazyRouteComponent(() => import('./features/settings/SettingsPage'), 'SettingsPage'),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  callbackRoute,
  appRoute.addChildren([
    dashboardRoute,
    agentsRoute,
    agentNewRoute,
    agentDetailRoute,
    wizardRoute,
    eventsRoute,
    runsRoute,
    runDetailRoute,
    connectionsRoute,
    policiesRoute,
    auditRoute,
    costsRoute,
    usersRoute,
    tokensRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
    defaultPreload: 'intent',
    // TanStack Query owns caching; the router only triggers prefetches.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: Loading,
    defaultPendingMs: 150,
    defaultErrorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} />,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

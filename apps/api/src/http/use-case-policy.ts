import { hasPermission, hasUseCasePermission, isUseCaseBinding } from '@openagentix/core';
import type { Permission, Principal } from '@openagentix/core';

/**
 * How every route that serves a signed-in principal treats a use-case administrator (ADR 0014
 * section 3.3, slice S8). A binding limited to a use case is not a node-wide binding:
 * `hasPermission` never counts it, so a route that does not know about use cases refuses it
 * (fail closed). A route opts in by being listed as `scoped` below, and its service must then
 * filter every row, detail, export and stream by the use cases the caller holds the permission for
 * (`useCaseScopes` / `hasPermissionIn`).
 *
 * - `scoped`: the route is open to a caller who holds the permission through a use-case binding,
 *   and the service restricts the result to that use case (and its sub-use cases).
 * - `denied`: the route needs the whole node (connections, event sources, policies, tokens, users,
 *   settings, audit verification, tenant structure, ...); a caller whose bindings are all limited
 *   to use cases is refused with 403, before the handler runs.
 * - `self`: an `authenticated` route that returns the caller's own context or names of nodes the
 *   caller can already see; it never returns data of a use case.
 *
 * **Every route with a permission or `authenticated` access must be listed** (the route-table test
 * fails otherwise, so a new route cannot ship without a decision), and a route that is not listed is
 * handled as `denied` at run time.
 */
export type UseCasePolicy = 'scoped' | 'denied' | 'self';

/** Key of a route in {@link USE_CASE_POLICY}. */
export const routeKey = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;

const SCOPED = [
  // agents (agents.use_case): list, detail, versions, members, writes, runs, dry run
  'GET /v1/agents',
  'POST /v1/agents',
  'POST /v1/agents/validate',
  'GET /v1/agents/:id',
  'PUT /v1/agents/:id/draft',
  'POST /v1/agents/:id/publish',
  'POST /v1/agents/:id/disable',
  'POST /v1/agents/:id/enable',
  'GET /v1/agents/:id/versions',
  'GET /v1/agents/:id/versions/:version',
  'GET /v1/agents/:id/members',
  'POST /v1/agents/:id/dry-run',
  'POST /v1/agents/:id/runs',
  // runs and approvals (through the agent of the run)
  'GET /v1/runs',
  'GET /v1/runs/:id',
  'GET /v1/runs/:id/steps',
  'GET /v1/runs/:id/stream',
  'POST /v1/runs/:id/stream-token',
  'POST /v1/runs/:id/cancel',
  'GET /v1/stats/runs',
  'GET /v1/approvals',
  'POST /v1/approvals/:id/decision',
  // events (through the agent of the source), audit entries of those agents and runs
  'GET /v1/events',
  'GET /v1/events/:id',
  'GET /v1/audit',
  'GET /v1/audit/export',
  // costs and budgets (cost_ledger.use_case)
  'GET /v1/costs/summary',
  'GET /v1/costs/export',
  'GET /v1/budgets',
  // tenant-neutral catalog an agent author needs
  'GET /v1/models',
  // the owning node of a resource the caller may read (deep links), the role-binding API
  'GET /v1/locate/:kind/:id',
  'GET /v1/tenants/:id/role-bindings',
  'POST /v1/tenants/:id/role-bindings',
  'PATCH /v1/tenants/:id/role-bindings/:bindingId',
  'DELETE /v1/tenants/:id/role-bindings/:bindingId',
] as const;

const SELF = [
  'GET /v1/me',
  'GET /v1/me/access',
  'GET /v1/me/notices',
  'GET /v1/settings',
  'POST /v1/auth/logout',
  'GET /v1/tenants',
  'GET /v1/tenants/:id',
  'GET /v1/tenants/search',
  'GET /v1/tenants/tree',
] as const;

const DENIED = [
  // restricting a role narrows every binding below the node: tenant administrators only
  'GET /v1/tenants/:id/role-restrictions',
  'PUT /v1/tenants/:id/role-restrictions',
  'DELETE /v1/tenants/:id/role-restrictions',
  // node-wide configuration and credentials
  'GET /v1/connections',
  'POST /v1/connections',
  'GET /v1/connections/:id',
  'PUT /v1/connections/:id',
  'DELETE /v1/connections/:id',
  'GET /v1/connections/:id/oauth',
  'POST /v1/connections/:id/oauth/authorize',
  'POST /v1/connections/:id/oauth/complete',
  'POST /v1/connections/:id/oauth/disconnect',
  'POST /v1/connections/:id/test',
  'POST /v1/connections/:id/tools/refresh',
  'GET /v1/connections/:id/tool-snapshots',
  'GET /v1/connections/:id/tool-snapshots/:digest',
  'POST /v1/connections/:id/tool-snapshots/:digest/approve',
  'POST /v1/connections/:id/tool-snapshots/:digest/reject',
  'GET /v1/connections/stdio-violations',
  'POST /v1/models/proposals',
  'GET /v1/policies',
  'POST /v1/policies',
  'GET /v1/policies/:id',
  'PUT /v1/policies/:id',
  'POST /v1/policies/evaluate',
  'GET /v1/guidelines',
  'POST /v1/guidelines',
  'POST /v1/guidelines/review',
  'GET /v1/event-sources',
  'POST /v1/event-sources',
  'GET /v1/event-sources/:id',
  'PATCH /v1/event-sources/:id',
  'DELETE /v1/event-sources/:id',
  // node-wide people: users, teams, tokens
  'GET /v1/users',
  'POST /v1/users',
  'GET /v1/users/:id',
  'PATCH /v1/users/:id',
  'GET /v1/teams',
  'POST /v1/teams',
  'GET /v1/teams/:id/members',
  'PUT /v1/teams/:id/members',
  'PATCH /v1/teams/:id',
  'DELETE /v1/teams/:id',
  'PUT /v1/agents/:id/members',
  'GET /v1/tokens',
  'POST /v1/tokens',
  'DELETE /v1/tokens/:id',
  // the chain as a whole, budgets of the node, plans and demo helpers
  'POST /v1/audit/verify',
  'GET /v1/audit/checkpoints',
  'POST /v1/audit/checkpoints',
  'PUT /v1/budgets/use-cases/:useCase',
  'DELETE /v1/budgets/use-cases/:useCase',
  'POST /v1/plans/check',
  'POST /v1/plans/generate',
  'GET /v1/demo/scenarios',
  'POST /v1/demo/scenarios/:scenario/run',
  // tenant structure: attaching a node is a grant, reserved for tenant administrators
  'POST /v1/tenants',
  'PATCH /v1/tenants/:id',
  'GET /v1/tenants/:id/access',
  'POST /v1/tenants/:id/role-bindings/enable-inheritance',
] as const;

export const USE_CASE_POLICY: Readonly<Record<string, UseCasePolicy>> = Object.freeze({
  ...Object.fromEntries(SCOPED.map((k) => [k, 'scoped' as const])),
  ...Object.fromEntries(SELF.map((k) => [k, 'self' as const])),
  ...Object.fromEntries(DENIED.map((k) => [k, 'denied' as const])),
});

/** True when every binding of the principal at the acting node is limited to a use case. */
export function isUseCaseOnly(principal: Pick<Principal, 'bindings'>): boolean {
  return principal.bindings.length > 0 && principal.bindings.every(isUseCaseBinding);
}

/**
 * The route-level decision for a signed-in principal (`access` is the route's declared permission
 * or `authenticated`): the permission as before, plus, for a `scoped` route, the permission held
 * for at least one use case. A route that is not in the registry counts as `denied`.
 */
export function routeAllows(
  principal: Principal,
  access: Permission | 'authenticated',
  method: string,
  url: string,
  registry: Readonly<Record<string, UseCasePolicy>> = USE_CASE_POLICY,
): boolean {
  const policy = registry[routeKey(method, url)];
  if (access === 'authenticated') {
    // Only a caller whose bindings are all use-case bindings is held back, and only by a route that
    // is `denied` or not listed; everybody else keeps the route as before.
    const open = policy === 'scoped' || policy === 'self';
    return open || !isUseCaseOnly(principal);
  }
  if (hasPermission(principal, access)) return true;
  return policy === 'scoped' && hasUseCasePermission(principal, access);
}

/** Access classes that serve no signed-in principal and so need no decision about use cases. */
const NO_PRINCIPAL = new Set(['public', 'run-token', 'model-token', 'webhook']);

/**
 * The routes (`METHOD url`) of a route table that serve a signed-in principal but have no entry in
 * the registry. Empty in a healthy tree: the route-table test fails otherwise, so a new
 * tenant-scoped route cannot ship without a decision about use cases.
 */
export function undeclaredRoutes(
  routes: readonly { method: string; url: string; access: unknown }[],
  registry: Readonly<Record<string, UseCasePolicy>> = USE_CASE_POLICY,
): string[] {
  return routes
    .filter((r) => !NO_PRINCIPAL.has(String(r.access)))
    .map((r) => routeKey(r.method, r.url))
    .filter((k) => registry[k] === undefined)
    .sort();
}

/** Entries of the registry that no route has (a renamed or removed route left a stale decision). */
export function staleDecisions(
  routes: readonly { method: string; url: string }[],
  registry: Readonly<Record<string, UseCasePolicy>> = USE_CASE_POLICY,
): string[] {
  const keys = new Set(routes.map((r) => routeKey(r.method, r.url)));
  return Object.keys(registry)
    .filter((k) => !keys.has(k))
    .sort();
}

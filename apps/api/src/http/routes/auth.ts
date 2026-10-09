import { effectivePermissions } from '@openagentix/core';
import type { Deps } from '../app.js';
import { bearerOf, principalOf } from '../app.js';
import { userDto } from '../dto.js';
import { AuthMethodsSchema, ErrorSchema, LoginBody, LoginResponse, MeSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const loginDto = (r: { token: string; expiresAt: Date; user: Parameters<typeof userDto>[0] }) => ({
  token: r.token,
  expiresAt: r.expiresAt.toISOString(),
  user: userDto(r.user),
});

export function registerAuthRoutes(app: ZApp, { ctx, services }: Deps): void {
  app.post(
    '/v1/auth/login',
    {
      config: {
        access: 'public',
        rateLimit: { max: ctx.config.rateLimit.loginMax, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['auth'],
        summary: 'Log in with local or LDAP credentials',
        body: LoginBody,
        response: { 200: LoginResponse, 401: ErrorSchema },
      },
    },
    async (req) =>
      loginDto(
        await services.identity.login(req.body.username, req.body.password, req.body.method),
      ),
  );

  app.get(
    '/v1/auth/methods',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        summary: 'Enabled login methods (for the sign-in page)',
        response: { 200: AuthMethodsSchema },
      },
    },
    async () => ({
      local: true,
      ldap: !!ctx.config.auth.ldap,
      oidc: ctx.config.auth.oidc
        ? { enabled: true, loginUrl: '/v1/auth/oidc/login' }
        : { enabled: false, loginUrl: null },
    }),
  );

  app.post(
    '/v1/auth/logout',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session token',
        security: [{ bearer: [] }],
      },
    },
    async (req, reply) => {
      await services.identity.logout(bearerOf(req) ?? '');
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/auth/oidc/login',
    {
      config: { access: 'public' },
      schema: { tags: ['auth'], summary: 'Start the OIDC authorization code flow (PKCE)' },
    },
    async (_req, reply) => reply.redirect(await services.identity.oidcStart()),
  );

  app.get(
    '/v1/auth/oidc/callback',
    {
      config: { access: 'public' },
      schema: {
        tags: ['auth'],
        summary: 'OIDC redirect target; returns a session or redirects to the UI',
      },
    },
    async (req, reply) => {
      const url = new URL(req.url, ctx.config.publicUrl);
      const session = await services.identity.oidcCallback(url);
      if (ctx.config.uiUrl) {
        const fragment = `token=${encodeURIComponent(session.token)}&expiresAt=${encodeURIComponent(session.expiresAt.toISOString())}`;
        return reply.redirect(`${ctx.config.uiUrl}/auth/callback#${fragment}`);
      }
      return loginDto(session);
    },
  );

  app.get(
    '/v1/me',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['auth'],
        summary: 'Current principal, the acting tenant and what the caller can switch to',
        description:
          'Honours `X-OAX-Tenant` (id, slug or slug path of a node the caller may act in; any other ' +
          'node is 404). The node that was used is also returned in the response header ' +
          '`X-OAX-Acting-Tenant`.',
        security: [{ bearer: [] }],
        response: { 200: MeSchema },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const ctxt = await services.tenants.views.actingContext(p);
      const ref = (t: { id: string; slug: string; name: string }) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
      });
      const visibleTenantCount = Math.max(ctxt.visibleTenantCount, 1);
      return {
        user: userDto(await services.identity.getUser(p.userId)),
        tenant: ref(ctxt.acting),
        actingTenant: {
          ...ref(ctxt.acting),
          slugPath: ctxt.slugPath,
          path: ctxt.path.map(ref),
        },
        homeTenant: { ...ref(ctxt.home), slugPath: ctxt.homeSlugPath },
        platformAdmin: p.platformAdmin,
        kind: p.kind,
        permissions: effectivePermissions(p),
        // Roles are bound on the home tenant until per-node bindings (ADR 0013 W13-6).
        bindings: p.bindings.map((b) => ({
          role: b.role,
          teamId: b.teamId,
          tenantId: ctxt.home.id,
          tenantSlugPath: ctxt.homeSlugPath,
          useCase: null,
          expiresAt: null,
        })),
        visibleTenantCount,
        installationMode: visibleTenantCount > 1 ? ('multi' as const) : ('single' as const),
      };
    },
  );
}

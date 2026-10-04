import { hasPermission } from '@openagentix/core';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { teamDto, tokenDto, userDto } from '../dto.js';
import {
  ErrorSchema,
  IdParams,
  IssuedTokenSchema,
  MembersBody,
  TeamCreateBody,
  TeamMemberSchema,
  TeamSchema,
  TokenCreateBody,
  TokenIdParams,
  TokenListQuery,
  TokenSchema,
  UserCreateBody,
  UserPatchBody,
  UserSchema,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];

export function registerUserRoutes(app: ZApp, { services }: Deps): void {
  const { identity } = services;

  app.get(
    '/v1/users',
    {
      config: { access: 'users:read' },
      schema: {
        tags: ['users'],
        summary: 'List users',
        security: sec,
        response: { 200: z.object({ items: z.array(UserSchema) }) },
      },
    },
    async (req) => ({
      items: (await identity.listUsers(principalOf(req))).map(userDto),
    }),
  );

  app.post(
    '/v1/users',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Create a local user',
        security: sec,
        body: UserCreateBody,
        response: { 201: UserSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply.status(201).send(userDto(await identity.createLocalUser(principalOf(req), req.body))),
  );

  app.get(
    '/v1/users/:id',
    {
      config: { access: 'users:read' },
      schema: {
        tags: ['users'],
        summary: 'Get a user',
        security: sec,
        params: IdParams,
        response: { 200: UserSchema },
      },
    },
    async (req) => userDto(await identity.getUser(req.params.id, principalOf(req).tenantId)),
  );

  app.get(
    '/v1/teams/:id/members',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['users'],
        summary: 'List the members of a team',
        security: sec,
        params: IdParams,
        response: { 200: z.object({ items: z.array(TeamMemberSchema) }) },
      },
    },
    async (req) => ({ items: await identity.teamMembers(principalOf(req), req.params.id) }),
  );

  app.patch(
    '/v1/teams/:id',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Rename a team or change its monthly budget (null removes it)',
        security: sec,
        params: IdParams,
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          monthlyBudgetUsd: z.number().positive().nullable().optional(),
        }),
        response: { 200: TeamSchema },
      },
    },
    async (req) => teamDto(await identity.updateTeam(principalOf(req), req.params.id, req.body)),
  );

  app.delete(
    '/v1/teams/:id',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Delete a team that owns no agents',
        security: sec,
        params: IdParams,
        response: { 204: z.null(), 409: ErrorSchema },
      },
    },
    async (req, reply) => {
      await identity.deleteTeam(principalOf(req), req.params.id);
      return reply.status(204).send(null);
    },
  );

  app.patch(
    '/v1/users/:id',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Update roles, name or disable a user',
        security: sec,
        params: IdParams,
        body: UserPatchBody,
        response: { 200: UserSchema },
      },
    },
    async (req) => userDto(await identity.updateUser(principalOf(req), req.params.id, req.body)),
  );

  app.get(
    '/v1/teams',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['users'],
        summary: 'List teams',
        security: sec,
        response: { 200: z.object({ items: z.array(TeamSchema) }) },
      },
    },
    async (req) => ({
      items: (await identity.listTeams(principalOf(req))).map((t) =>
        teamDto({ ...t, createdAt: new Date(t.createdAt) }),
      ),
    }),
  );

  app.post(
    '/v1/teams',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Create a team (optional monthly budget)',
        security: sec,
        body: TeamCreateBody,
        response: { 201: TeamSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply.status(201).send(teamDto(await identity.createTeam(principalOf(req), req.body))),
  );

  app.put(
    '/v1/teams/:id/members',
    {
      config: { access: 'users:write' },
      schema: {
        tags: ['users'],
        summary: 'Replace the members (user + role) of a team',
        security: sec,
        params: IdParams,
        body: MembersBody,
      },
    },
    async (req, reply) => {
      await identity.setTeamMembers(principalOf(req), req.params.id, req.body.members);
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/tokens',
    {
      config: { access: 'tokens:read' },
      schema: {
        tags: ['tokens'],
        summary: 'List API tokens (own; `all=true` for admins)',
        security: sec,
        querystring: TokenListQuery,
        response: { 200: z.object({ items: z.array(TokenSchema) }) },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const all = req.query.all && hasPermission(p, 'settings:write');
      return { items: (await identity.listTokens(p, all ? null : p.userId)).map(tokenDto) };
    },
  );

  app.post(
    '/v1/tokens',
    {
      config: { access: 'tokens:write' },
      schema: {
        tags: ['tokens'],
        summary: 'Create a scoped, expiring API token',
        security: sec,
        body: TokenCreateBody,
        response: { 201: IssuedTokenSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const t = await identity.createApiToken(
        principalOf(req),
        req.body.name,
        req.body.scopes,
        req.body.expiresInDays,
      );
      return reply.status(201).send({ ...tokenDto(t), token: t.token });
    },
  );

  app.delete(
    '/v1/tokens/:id',
    {
      config: { access: 'tokens:write' },
      schema: {
        tags: ['tokens'],
        summary: 'Revoke an API token',
        security: sec,
        params: TokenIdParams,
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      await identity.revokeToken(p, req.params.id, hasPermission(p, 'settings:write'));
      return reply.status(204).send();
    },
  );
}

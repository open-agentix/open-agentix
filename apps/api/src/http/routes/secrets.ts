import { z } from 'zod';
import type { SecretView } from '../../services/secrets.js';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import {
  CreateSecretBody,
  RotateSecretBody,
  SecretListQuery,
  SecretListSchema,
  SecretPolicyBody,
  SecretPolicySchema,
  SecretSchema,
} from '../secret-schemas.js';
import { ErrorSchema, IdParams } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['secrets'];
const iso = (d: Date) => d.toISOString();

const dto = (v: SecretView): z.infer<typeof SecretSchema> => ({
  ...v,
  createdAt: iso(v.createdAt),
  rotatedAt: v.rotatedAt ? iso(v.rotatedAt) : null,
  expiresAt: v.expiresAt ? iso(v.expiresAt) : null,
  revokedAt: v.revokedAt ? iso(v.revokedAt) : null,
});

const errors = { 400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema };

/**
 * Secrets (ADR 0017 section 13): metadata, and write-only values. **No route returns a value**, not
 * to the creator, not to an administrator: a value is accepted by `POST /v1/secrets` and
 * `POST /v1/secrets/:id/rotate` and read only by the credential broker when a run needs it. The
 * route-level permission is the weakest one that applies (`secrets:read`); the service enforces the
 * permission of the scope (node-wide, team, or the owner for personal secrets).
 */
export function registerSecretRoutes(app: ZApp, { services }: Deps): void {
  const { secrets } = services;

  app.get(
    '/v1/secrets',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'List secrets (metadata only)',
        description:
          'Tenant scope lists the secrets of the acting node and the inheritable ones of its ancestors (flagged `inherited`, without the creator). Team scope needs `teamId`. Personal scope lists your own. Values are never returned.',
        security: sec,
        querystring: SecretListQuery,
        response: { 200: SecretListSchema, ...errors },
      },
    },
    async (req) => {
      const r = await secrets.list(principalOf(req), req.query);
      return { items: r.items.map(dto), nextCursor: r.nextCursor };
    },
  );

  app.post(
    '/v1/secrets',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Create a secret',
        description:
          'The value is accepted here and never returned. At least 8 characters, at most 64 KiB. `pointer` instead of `value` creates a pointer to an operator environment secret (no value is copied). A tenant secret owned by a root node cannot be shadowed below unless `allowOverride` is true.',
        security: sec,
        body: CreateSecretBody,
        response: {
          201: SecretSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          503: ErrorSchema,
          ...errors,
        },
      },
    },
    async (req, reply) =>
      reply.status(201).send(dto(await secrets.create(principalOf(req), req.body))),
  );

  app.get(
    '/v1/secrets/policy',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Inherited secret names this node blocks',
        security: sec,
        response: { 200: SecretPolicySchema, ...errors },
      },
    },
    async (req) => secrets.policy(principalOf(req)),
  );

  app.put(
    '/v1/secrets/policy',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Block inherited secret names for this node and its subtree',
        description:
          'Narrowing only: a blocked inherited name resolves to `secret_not_found` below this node unless the node or a descendant defines its own.',
        security: sec,
        body: SecretPolicyBody,
        response: { 200: SecretPolicySchema, ...errors },
      },
    },
    async (req) => {
      const p = principalOf(req);
      await secrets.setPolicy(p, req.body);
      return secrets.policy(p);
    },
  );

  app.get(
    '/v1/secrets/:id',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Metadata of a secret',
        security: sec,
        params: IdParams,
        response: { 200: SecretSchema, ...errors },
      },
    },
    async (req) => dto(await secrets.get(principalOf(req), req.params.id)),
  );

  app.post(
    '/v1/secrets/:id/rotate',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Rotate a secret to a new value',
        description:
          'Creates the next version; new issuances use it, sessions that already received the old value keep it until their step ends. Only on the owning node.',
        security: sec,
        params: IdParams,
        body: RotateSecretBody,
        response: { 200: SecretSchema, 409: ErrorSchema, 503: ErrorSchema, ...errors },
      },
    },
    async (req) => dto(await secrets.rotate(principalOf(req), req.params.id, req.body)),
  );

  app.post(
    '/v1/secrets/:id/revoke',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Revoke a secret',
        description:
          'Blocks new issuances immediately and removes the stored values. The name stays taken. Cannot be undone.',
        security: sec,
        params: IdParams,
        response: { 200: SecretSchema, 409: ErrorSchema, ...errors },
      },
    },
    async (req) => dto(await secrets.revoke(principalOf(req), req.params.id)),
  );

  app.delete(
    '/v1/secrets/:id',
    {
      config: { access: 'secrets:read' },
      schema: {
        tags,
        summary: 'Delete a secret',
        description:
          'Removes the secret and its values. A published version that pinned it fails closed at run time until a new revision is approved.',
        security: sec,
        params: IdParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await secrets.remove(principalOf(req), req.params.id);
      return reply.status(204).send(null);
    },
  );
}

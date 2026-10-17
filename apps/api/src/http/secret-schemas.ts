import {
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_LENGTH,
  SECRET_NAME_PATTERN,
  SECRET_SCOPES,
  parseDestinations,
} from '@openagentix/core';
import { z } from 'zod';
import { Id, Iso } from './schemas.js';

/**
 * Schemas of the secrets API (ADR 0017 section 13, slice S4). Values are accepted by exactly two
 * request bodies (`CreateSecretBody`, `RotateSecretBody`) and returned by none: no response schema in
 * this file has a field for a value, a ciphertext or a key.
 */

export const SecretScopeSchema = z.enum(SECRET_SCOPES);

const Name = z.string().regex(SECRET_NAME_PATTERN, 'lower case letters, digits, "_", "." or "-"');

/** The value of a secret: at least the redaction minimum, at most 64 KiB (counted in bytes). */
export const SecretValue = z
  .string()
  .min(MIN_SECRET_VALUE_LENGTH, `a secret value has at least ${MIN_SECRET_VALUE_LENGTH} characters`)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_SECRET_VALUE_BYTES, {
    message: `a secret value has at most ${MAX_SECRET_VALUE_BYTES} bytes`,
  });

const Destinations = z
  .array(z.string())
  .max(64)
  .refine((v) => parseDestinations(v) !== null, {
    message: 'host names or "*.suffix" patterns (lower case, no ports, no addresses)',
  });

const Common = {
  description: z.string().max(500).optional(),
  usage: z.enum(['development', 'production', 'any']).default('any'),
  allowedDestinations: Destinations.default([]),
  expiresAt: Iso.datetime().optional(),
};

const Inheritance = {
  inherit: z
    .boolean()
    .optional()
    .describe('tenant scope: inherit down the tree (default true); false keeps it node-only'),
  allowOverride: z
    .boolean()
    .optional()
    .describe(
      'tenant scope: a lower node may shadow the name (default false on a root node, true below)',
    ),
};

/** A secret with a value (the internal store) or a pointer to an operator environment secret. */
export const CreateSecretBody = z
  .strictObject({
    scope: SecretScopeSchema,
    name: Name,
    teamId: Id.optional().describe('required for scope=team'),
    value: SecretValue.optional().describe('write-only; required unless `pointer` is given'),
    pointer: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
      .optional()
      .describe(
        'import helper: the legacy reference (OAX_SECRET_<NAME> or file) this secret points at; no value is copied',
      ),
    ...Common,
    ...Inheritance,
  })
  .superRefine((b, ctx) => {
    if ((b.value === undefined) === (b.pointer === undefined))
      ctx.addIssue({ code: 'custom', message: 'give exactly one of value and pointer' });
    if (b.scope === 'team' && !b.teamId)
      ctx.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'teamId is required for a team secret',
      });
    if (b.scope !== 'team' && b.teamId)
      ctx.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'teamId is for team secrets only',
      });
    if (b.scope !== 'tenant' && (b.inherit !== undefined || b.allowOverride !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'inherit and allowOverride apply to tenant secrets only',
      });
    if (b.pointer !== undefined && b.scope === 'personal')
      ctx.addIssue({
        code: 'custom',
        path: ['pointer'],
        message: 'a personal secret holds a value',
      });
  });

export const RotateSecretBody = z.strictObject({
  value: SecretValue,
  expiresAt: Iso.datetime().nullable().optional().describe('a new expiry; null clears it'),
});

export const SecretListQuery = z.object({
  scope: SecretScopeSchema.default('tenant'),
  teamId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
});

/**
 * Metadata of a secret. There is no value, no ciphertext and no key here, by design. The creator is
 * shown for secrets of the acting node only, never for an inherited one.
 */
export const SecretSchema = z.object({
  id: Id,
  scope: SecretScopeSchema,
  name: z.string(),
  reference: z.string().describe('what an agent writes: `<scope>:<name>`'),
  ownerNode: z.object({ id: Id, slugPath: z.string() }),
  teamId: Id.nullable(),
  backend: z.enum(['internal', 'env']),
  pointer: z.string().nullable().describe('own secrets only'),
  version: z.number().int(),
  description: z.string().nullable(),
  usage: z.enum(['development', 'production', 'any']),
  allowedDestinations: z.array(z.string()),
  inherit: z.boolean(),
  allowOverride: z.boolean(),
  state: z.enum(['active', 'expired', 'revoked']),
  inherited: z.boolean().describe('owned by an ancestor node and visible here by inheritance'),
  createdBy: Id.nullable().describe('own secrets only'),
  createdAt: Iso,
  rotatedAt: Iso.nullable(),
  expiresAt: Iso.nullable(),
  revokedAt: Iso.nullable(),
});

export const SecretListSchema = z.object({
  items: z.array(SecretSchema),
  nextCursor: z.string().nullable(),
});

export const SecretPolicyBody = z.strictObject({
  blockInherited: z
    .array(z.string().regex(/^[a-z0-9*][a-z0-9_.*-]{0,127}$/))
    .max(64)
    .describe(
      'name globs ("*" only) of inherited tenant secrets this node and its subtree do not see',
    ),
});

export const SecretPolicySchema = z.object({
  blockInherited: z.array(z.string()).describe('what this node stores itself'),
  effectiveBlocked: z
    .array(z.string())
    .describe('the union down the chain: own globs and those of the ancestors'),
});

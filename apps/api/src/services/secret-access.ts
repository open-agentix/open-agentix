import {
  hasPermission,
  type Permission,
  type Principal,
  type SecretScope,
} from '@openagentix/core';
import { forbidden } from '../errors.js';

/**
 * Who may read or write a secret of a scope (ADR 0017 section 13.4). `tenant` secrets need the
 * permission held **node-wide** at the acting node (`null` asks for a node-wide binding: a binding on
 * one team does not manage tenant secrets); `team` secrets need it on that team; `personal` secrets
 * need `agents:write` somewhere, and the caller must also be the owner (checked where the row is read).
 */
export function canSecrets(
  p: Principal,
  op: 'read' | 'write',
  scope: SecretScope,
  teamId: string | null,
): boolean {
  const permission: Permission = op === 'read' ? 'secrets:read' : 'secrets:write';
  if (scope === 'personal') return hasPermission(p, 'agents:write');
  return hasPermission(p, permission, scope === 'team' ? teamId : null);
}

export function assertSecrets(
  p: Principal,
  op: 'read' | 'write',
  scope: SecretScope,
  teamId: string | null,
): void {
  if (!canSecrets(p, op, scope, teamId)) throw forbidden(`missing permission secrets:${op}`);
}

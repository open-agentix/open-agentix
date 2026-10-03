import { OaxError } from '@openagentix/core';
import { Client } from 'ldapts';
import type { Config } from '../config.js';

/** The ldapts surface we use (injectable for tests). */
export interface LdapClientLike {
  bind(dn: string, password: string): Promise<void>;
  search(
    base: string,
    options: { scope: 'sub'; filter: string; attributes: string[]; sizeLimit: number },
  ): Promise<{ searchEntries: Record<string, unknown>[] }>;
  unbind(): Promise<void>;
}

export type LdapClientFactory = (url: string, tlsRejectUnauthorized: boolean) => LdapClientLike;

export const ldaptsFactory: LdapClientFactory = (url, rejectUnauthorized) =>
  new Client({
    url,
    timeout: 10_000,
    connectTimeout: 5_000,
    tlsOptions: { rejectUnauthorized },
  }) as unknown as LdapClientLike;

/** RFC 4515 escaping for values inserted into LDAP filters. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export interface LdapIdentity {
  dn: string;
  email: string;
  displayName: string;
  groups: string[];
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * Service bind -> search the user -> bind as the user with the given password.
 * Returns identity + group DNs (for group -> role mapping).
 */
export async function ldapAuthenticate(
  cfg: NonNullable<Config['auth']['ldap']>,
  username: string,
  password: string,
  factory: LdapClientFactory = ldaptsFactory,
): Promise<LdapIdentity> {
  if (!password) throw new OaxError('unauthenticated', 'invalid credentials');
  const client = factory(cfg.url, cfg.tlsRejectUnauthorized);
  try {
    if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword ?? '');
    const filter = cfg.userFilter.replaceAll('{username}', escapeLdapFilter(username));
    const { searchEntries } = await client.search(cfg.userBaseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'mail', 'cn', 'displayName', cfg.groupAttribute],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) throw new OaxError('unauthenticated', 'invalid credentials');
    const entry = searchEntries[0]!;
    const dn = String(entry.dn);
    try {
      await client.bind(dn, password);
    } catch {
      throw new OaxError('unauthenticated', 'invalid credentials');
    }
    const groupsRaw = entry[cfg.groupAttribute];
    const groups = (Array.isArray(groupsRaw) ? groupsRaw : groupsRaw ? [groupsRaw] : []).map(
      String,
    );
    return {
      dn,
      email: first(entry.mail) ?? `${username}@ldap.invalid`,
      displayName: first(entry.displayName) ?? first(entry.cn) ?? username,
      groups,
    };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Permission } from '../../../../packages/core/src/rbac';
import { api, call } from '../api/client';
import type { BodyOf } from '../api/types';
import { session } from './session';

export type { Permission };

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => call(api.GET('/v1/me')),
  staleTime: 5 * 60_000,
});

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => call(api.GET('/v1/settings')),
  staleTime: 5 * 60_000,
});

export const versionQuery = queryOptions({
  queryKey: ['version'],
  queryFn: () => call(api.GET('/v1/version')),
  staleTime: Infinity,
});

export async function login(
  queryClient: QueryClient,
  body: BodyOf<'/v1/auth/login', 'post'>,
): Promise<void> {
  const res = await call(api.POST('/v1/auth/login', { body }));
  session.set(res.token, res.expiresAt);
  queryClient.removeQueries({ queryKey: ['me'] });
}

export async function logout(queryClient: QueryClient): Promise<void> {
  try {
    await call(api.POST('/v1/auth/logout'));
  } catch {
    /* the local session is dropped either way */
  }
  session.clear();
  queryClient.clear();
}

/** Start URL of the OIDC authorization code flow (browser navigation, not fetch). */
export function oidcLoginUrl(base: string): string {
  return `${base}/v1/auth/oidc/login`;
}

/** Returns a permission check for the current principal. The API stays the authority. */
export function useCan(): (permission: Permission) => boolean {
  const { data } = useQuery(meQuery);
  return (permission) => !!data?.permissions.includes(permission);
}

/** Renders children only with the permission (or the fallback, e.g. a disabled control). */
export function Can({
  perm,
  children,
  fallback = null,
}: {
  perm: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const can = useCan();
  return <>{can(perm) ? children : fallback}</>;
}

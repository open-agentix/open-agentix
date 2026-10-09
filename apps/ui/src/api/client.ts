import createClient, { type Middleware } from 'openapi-fetch';
import { session } from '../auth/session';
import { activeTenant } from '../lib/activeTenant';
import type { paths } from './schema';

/** Base URL of the control node API; empty = same origin (dev server proxies /v1). */
export function apiBase(): string {
  const configured = (import.meta.env.VITE_OAX_API_URL as string | undefined) ?? '';
  return (configured || window.location.origin).replace(/\/$/, '');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function toApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object' && 'message' in body) {
    const b = body as { error?: unknown; message?: unknown; details?: unknown };
    return new ApiError(
      status,
      typeof b.error === 'string' ? b.error : 'error',
      String(b.message),
      b.details,
    );
  }
  return new ApiError(status, status === 0 ? 'network' : 'error', `HTTP ${status}`);
}

export function authHeaders(): Record<string, string> {
  const token = session.token();
  const tenant = activeTenant.header();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(token && tenant ? { 'x-oax-tenant': tenant } : {}),
  };
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = session.token();
    if (token) {
      request.headers.set('authorization', `Bearer ${token}`);
      // The acting tenant travels on every call; the API is the authority and refuses (404) a
      // tenant the principal may not act in. Without a choice the header is removed, never left
      // over from the caller.
      const tenant = activeTenant.header();
      if (tenant) request.headers.set('x-oax-tenant', tenant);
      else request.headers.delete('x-oax-tenant');
    }
    return request;
  },
  async onResponse({ request, response }) {
    if (response.status === 401 && session.token()) session.expire();
    // A stale choice (tenant deleted, access removed): fall back to the home tenant.
    const sent = request.headers.get('x-oax-tenant');
    if (response.status === 404 && sent) {
      try {
        const body = (await response.clone().json()) as { message?: unknown };
        // A late answer for a tenant the user already left must not undo the newer choice.
        if (body.message === 'tenant not found' && activeTenant.header() === sent)
          activeTenant.clear('stale');
      } catch {
        /* not the tenant refusal */
      }
    }
    return response;
  },
};

export const api = createClient<paths>({
  baseUrl: apiBase(),
  // Resolve fetch lazily so test interceptors and polyfills are honoured.
  fetch: (request: Request) => globalThis.fetch(request),
});
api.use(auth);

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Unwraps an openapi-fetch result: returns the data or throws an ApiError. */
export async function call<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
  }
  const { data, error, response } = result;
  if (!response.ok || error !== undefined) throw toApiError(response.status, error);
  return data as T;
}

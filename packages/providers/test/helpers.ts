import type { FetchLike } from '../src/index.js';

export interface Captured {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

/** Fake fetch returning queued responses and capturing requests. */
export function fakeFetch(responses: (Response | Error)[]): {
  fetch: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      init,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

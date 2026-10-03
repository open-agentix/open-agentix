import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppContext } from '@openagentix/api';

export interface WorkerProbe {
  id: string;
  running: boolean;
  activeRuns: number;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Small HTTP server of the worker process for probes and Prometheus:
 * `/healthz` (liveness), `/readyz` (database + schema + loop running), `/metrics`.
 */
export function createWorkerHttpServer(ctx: AppContext, worker: WorkerProbe): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      if (path === '/healthz') return send(res, 200, { status: 'ok', workerId: worker.id });
      if (path === '/readyz') {
        const db = await ctx.database.ping().catch(() => false);
        const schema = db ? await ctx.database.schemaStatus().catch(() => null) : null;
        const ok = db && !!schema?.ok && worker.running;
        return send(res, ok ? 200 : 503, {
          status: ok ? 'ok' : 'unavailable',
          checks: { database: db, schema: !!schema?.ok, loop: worker.running },
          activeRuns: worker.activeRuns,
        });
      }
      if (path === '/metrics') {
        const auth = req.headers.authorization;
        if (ctx.config.metricsToken && auth !== `Bearer ${ctx.config.metricsToken}`)
          return send(res, 401, { error: 'unauthenticated' });
        return send(
          res,
          200,
          await ctx.metrics.registry.metrics(),
          ctx.metrics.registry.contentType,
        );
      }
      return send(res, 404, { error: 'not_found' });
    })().catch((err: unknown) => {
      ctx.logger.error({ err }, 'worker http error');
      send(res, 500, { error: 'internal_error' });
    });
  });
}

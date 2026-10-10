import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  JsonTraceSerializer,
  ProtobufTraceSerializer,
  type ISerializer,
} from '@opentelemetry/otlp-transformer';
import type { CompiledNetwork, SecretResolver } from '@openagentix/core';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';

/**
 * The OTLP/HTTP transport of the trace exporter (ADR 0015 section 8, slice S7).
 *
 * The stock OTLP exporter opens its own sockets through `http.request`, which would bypass the
 * outbound dispatcher (ADR 0011): routes, proxies, trust bundles, client certificates, the
 * air-gapped allowlist and the metadata veto. This exporter only serialises the spans (with the
 * OpenTelemetry serializers) and posts the bytes through `OutboundDispatcher.fetch` with the
 * purpose `telemetry`, so the dispatcher's rules apply to every request: TLS verification is
 * always on, redirects are an error, and connect, header, body and total times and the response
 * size are bounded. Nothing is retried: a failed batch is dropped and counted, the next batch
 * goes out on schedule.
 *
 * Errors leaving this class are fixed, constant shapes (a name and a code, never a message): the
 * original error can name the destination, and the request carries the exporter credentials.
 */

const gzipAsync = promisify(gzip);

/** A request larger than this is not sent (a batch is at most 512 spans of bounded size). */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** The response of an OTLP collector is a few bytes; anything bigger is an error. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Concurrent requests; the batch processor sends one at a time, this is a hard backstop. */
export const MAX_IN_FLIGHT = 2;

export interface DispatcherExporterOptions {
  dispatcher: OutboundDispatcher;
  /** Full URL of the traces endpoint (`<endpoint>/v1/traces`). */
  url: string;
  protocol: 'http/protobuf' | 'http/json';
  /** Static exporter headers from the secret (never logged, never part of an error). */
  headers?: Record<string, string> | undefined;
  compression: 'none' | 'gzip';
  timeoutMs: number;
}

/** A failure the guarded wrapper can classify without ever seeing a message. */
function failure(kind: 'timeout' | 'network' | 'http' | 'other', status?: number): ExportResult {
  const error =
    kind === 'timeout'
      ? Object.assign(new Error('OTLP export timed out'), { name: 'AbortError' })
      : kind === 'http'
        ? Object.assign(new Error('OTLP export refused by the collector'), {
            name: 'OTLPExporterError',
            code: status ?? 0,
          })
        : kind === 'network'
          ? Object.assign(new Error('OTLP export failed'), { code: 'ECONNFAILED' })
          : new Error('OTLP export failed');
  return { code: ExportResultCode.FAILED, error };
}

function classify(e: unknown): ExportResult {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return failure('timeout');
  return failure('network');
}

export class DispatcherSpanExporter implements SpanExporter {
  private readonly serializer: ISerializer<ReadableSpan[], unknown>;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly opts: DispatcherExporterOptions,
    /** Close the dispatcher on shutdown (set when this exporter created it). */
    private readonly ownsDispatcher = false,
  ) {
    this.serializer = (
      opts.protocol === 'http/json' ? JsonTraceSerializer : ProtobufTraceSerializer
    ) as ISerializer<ReadableSpan[], unknown>;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.closed || this.inFlight.size >= MAX_IN_FLIGHT) {
      resultCallback(failure('other'));
      return;
    }
    const tracked: Promise<void> = this.send(spans)
      .then(resultCallback, () => resultCallback(failure('other')))
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private async send(spans: ReadableSpan[]): Promise<ExportResult> {
    let body: Uint8Array | undefined;
    try {
      body = this.serializer.serializeRequest(spans);
      if (!body || body.byteLength > MAX_REQUEST_BYTES) return failure('other');
      if (this.opts.compression === 'gzip') body = await gzipAsync(body);
    } catch {
      return failure('other');
    }
    const headers: Record<string, string> = {
      ...this.opts.headers,
      'content-type':
        this.opts.protocol === 'http/json' ? 'application/json' : 'application/x-protobuf',
      'user-agent': 'openagentix-otlp',
      ...(this.opts.compression === 'gzip' ? { 'content-encoding': 'gzip' } : {}),
    };
    try {
      const res = await this.opts.dispatcher.fetch(
        this.opts.url,
        { method: 'POST', headers, body: Buffer.from(body) },
        { purpose: 'telemetry', timeoutMs: this.opts.timeoutMs },
      );
      // The body is never read: a collector answers with an empty or tiny message.
      void res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status <= 299) return { code: ExportResultCode.SUCCESS };
      return failure('http', res.status);
    } catch (e) {
      return classify(e);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.forceFlush();
    if (this.ownsDispatcher) await this.opts.dispatcher.close().catch(() => undefined);
  }
}

/** Secret references the network configuration points at (proxy auth, trust bundles, mTLS). */
function networkSecretRefs(net: CompiledNetwork): string[] {
  const c = net.config;
  const refs = [
    ...c.proxies.map((p) => p.authSecret),
    ...c.trust.bundles.map((b) => b.secret),
    ...c.clientCertificates.flatMap((x) => [x.certSecret, x.keySecret]),
  ];
  return [...new Set(refs.filter((r): r is string => typeof r === 'string' && r !== ''))];
}

/**
 * The dispatcher reads secrets synchronously, so the ones the network configuration references
 * are loaded once, before the first request. A secret that cannot be loaded is left out: the
 * dispatcher then refuses a route that needs it (`network_secret_unavailable`) and the exporter
 * is not created, while routes that do not need it are unaffected.
 */
export async function loadNetworkSecrets(
  net: CompiledNetwork,
  secrets: SecretResolver,
): Promise<{ read: (ref: string) => string | undefined; values: string[] }> {
  const loaded = new Map<string, string>();
  for (const ref of networkSecretRefs(net)) {
    try {
      loaded.set(ref, await secrets.resolve(ref));
    } catch {
      // see above
    }
  }
  return { read: (ref) => loaded.get(ref), values: [...loaded.values()] };
}

/** The dispatcher of the exporter: the process's network configuration, tight limits. */
export function createTelemetryDispatcher(
  net: CompiledNetwork | undefined,
  secrets: (ref: string) => string | undefined,
  timeoutMs: number,
): OutboundDispatcher {
  return createOutboundDispatcher({
    ...(net ? { network: net } : {}),
    secrets,
    limits: {
      connectTimeoutMs: Math.min(15_000, timeoutMs),
      headersTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    },
  });
}

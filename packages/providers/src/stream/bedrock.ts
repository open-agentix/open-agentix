import {
  InvokeModelWithResponseStreamCommand,
  type BedrockRuntimeClient,
  type InvokeModelWithResponseStreamCommandOutput,
  type ResponseStream,
} from '@aws-sdk/client-bedrock-runtime';
import { OaxError, getEgressPolicy } from '@openagentix/core';
import { createBedrockClient, type BedrockOptions } from '../bedrock.js';
import { createAnthropicHandler } from './anthropic.js';
import {
  StreamGuard,
  createUpstreamStream,
  scrub,
  type FrameBatch,
  type FrameSource,
} from './engine.js';
import { resolveLimits } from './http.js';
import {
  StreamAbortedError,
  StreamError,
  type StreamCallOptions,
  type StreamLimits,
  type StreamingTransport,
  type UpstreamStream,
} from './types.js';
import { ProviderError } from '../http.js';

/** Minimal client surface used by the transport (injectable for tests). */
export interface BedrockStreamClient {
  send(
    command: InvokeModelWithResponseStreamCommand,
    options?: { abortSignal?: AbortSignal | undefined },
  ): Promise<Pick<InvokeModelWithResponseStreamCommandOutput, 'body'>>;
}

export interface BedrockStreamOptions extends Pick<
  BedrockOptions,
  'region' | 'endpoint' | 'proxyUrl' | 'maxAttempts' | 'credentials' | 'catalogProvider'
> {
  limits?: Partial<StreamLimits> | undefined;
  /** `anthropic_version` of the body. Default `bedrock-2023-05-31`. */
  anthropicVersion?: string | undefined;
  secrets?: readonly string[] | undefined;
  client?: BedrockStreamClient | undefined;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

const EXCEPTIONS = [
  'internalServerException',
  'modelStreamErrorException',
  'modelTimeoutException',
  'serviceUnavailableException',
  'throttlingException',
  'validationException',
] as const;

function bedrockSource(
  body: AsyncIterable<ResponseStream>,
  limits: StreamLimits,
  secrets: readonly string[],
): FrameSource {
  const it = body[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    async read(): Promise<FrameBatch> {
      const r = await it.next();
      if (r.done) return { done: true };
      const member = r.value as Record<string, unknown> & { chunk?: { bytes?: Uint8Array } };
      for (const name of EXCEPTIONS) {
        const ex = member[name] as { message?: string } | undefined;
        if (ex) {
          throw new StreamError(
            'upstream_error',
            `provider stream error: ${name}: ${scrub(String(ex.message ?? ''), secrets)}`,
          );
        }
      }
      const bytes = member.chunk?.bytes;
      if (!bytes) throw new StreamError('invalid_event', 'upstream sent an unknown stream member');
      if (bytes.byteLength > limits.maxEventBytes) {
        throw new StreamError('event_too_large', 'upstream event exceeds the event size limit');
      }
      let data: string;
      try {
        data = decoder.decode(bytes);
      } catch {
        throw new StreamError('invalid_utf8', 'upstream stream contains invalid UTF-8');
      }
      return { done: false, frames: [{ event: 'message', data }], bytes: bytes.byteLength };
    },
    finish() {
      // Frames are whole events; nothing can be buffered.
    },
    async close() {
      await it.return?.(undefined as never).catch(() => undefined);
    },
  };
}

/**
 * Streaming upstream transport for Bedrock `InvokeModelWithResponseStream` with the Anthropic body
 * (ADR 0009 section 2.4: Anthropic model ids only; other models use the native surface).
 */
export class BedrockStreamTransport implements StreamingTransport {
  readonly name = 'bedrock';
  private readonly client: BedrockStreamClient;
  private readonly endpoint: string;

  constructor(private readonly opts: BedrockStreamOptions) {
    this.endpoint = opts.endpoint ?? `https://bedrock-runtime.${opts.region}.amazonaws.com`;
    this.client = opts.client ?? (createBedrockClient(opts) as unknown as BedrockRuntimeClient);
  }

  async open(
    request: { body: Record<string, unknown>; model?: string | undefined },
    call: StreamCallOptions = {},
  ): Promise<UpstreamStream> {
    const modelId = request.model;
    if (!modelId || !MODEL_ID.test(modelId)) {
      throw new OaxError('model_request_invalid', 'invalid Bedrock model id');
    }
    // The AWS SDK does its own networking; the egress policy is asserted here.
    getEgressPolicy().assert(this.endpoint, 'provider');
    const limits = resolveLimits(this.opts.limits);
    const secrets = [...(this.opts.secrets ?? [])];
    const { model: _model, stream: _stream, anthropic_version: _v, ...rest } = request.body;
    const guard = new StreamGuard(limits, call.signal);
    let out: Pick<InvokeModelWithResponseStreamCommandOutput, 'body'>;
    try {
      out = await guard.race(
        this.client.send(
          new InvokeModelWithResponseStreamCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
              ...rest,
              anthropic_version: this.opts.anthropicVersion ?? 'bedrock-2023-05-31',
            }),
          }),
          { abortSignal: guard.signal },
        ),
      );
    } catch (e) {
      guard.dispose();
      const c = guard.cause;
      if (c?.kind === 'error') throw c.error;
      if (c?.kind === 'external') throw new StreamAbortedError(c.reason);
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = err.$metadata?.httpStatusCode ?? null;
      throw new ProviderError(
        `HTTP ${status ?? 'error'} from provider: ${scrub(`${err.name ?? 'Error'}: ${e instanceof Error ? e.message : ''}`, secrets)}`,
        status,
        status === 429 || (status !== null && status >= 500),
      );
    }
    if (!out.body) {
      guard.dispose();
      throw new StreamError('bad_content_type', 'upstream returned no stream');
    }
    return createUpstreamStream({
      status: 200,
      source: bedrockSource(out.body, limits, secrets),
      handler: createAnthropicHandler(secrets),
      limits,
      guard,
      call,
      secrets,
    });
  }
}

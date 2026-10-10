import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { McpCredentials, type TrustedRole } from './credentials.js';
import { KeyService } from './key-service.js';
import { processSecrets, type SecretRegistry } from './secret-registry.js';
import { McpOauthClientStore, McpOauthTokenStore } from './token-store.js';

export interface McpOauthStores {
  registry: SecretRegistry;
  keys: KeyService;
  tokens: McpOauthTokenStore;
  clients: McpOauthClientStore;
  credentials: McpCredentials;
}

/** Builds the key service, the stores and the credentials service of one trusted process. */
export function createMcpOauth(
  ctx: { db: Db; config: Config; now: () => Date },
  role: TrustedRole,
  registry: SecretRegistry = processSecrets,
): McpOauthStores {
  const { kek } = ctx.config.mcp.oauth;
  const keys = new KeyService(ctx.db, kek, ctx.now);
  const tokens = new McpOauthTokenStore(ctx.db, keys, registry, ctx.now);
  return {
    registry,
    keys,
    tokens,
    clients: new McpOauthClientStore(ctx.db, keys),
    credentials: new McpCredentials(tokens, registry, ctx.now, role),
  };
}

export { McpCredentials, KeyService, McpOauthClientStore, McpOauthTokenStore };
export type { TrustedRole };
export { SecretRegistry, processSecrets } from './secret-registry.js';
export { scrubbingDestination, type LineSink } from './scrubbing-stream.js';
export { scrubResponses } from './http.js';
export {
  scrubJsonText,
  scrubLeaves,
  scrubPayloadWith,
  scrubStdio,
  stringifyScrubbed,
} from './scrub.js';
export { canonicalResource } from './resource.js';
export type { TokenRefresher } from './credentials.js';
export { assertTokenShape } from './token-shape.js';
export { RegistryGuard } from './telemetry-guard.js';

import { EgressPolicy, parseAllowlist } from '@openagentix/core';
import { EgressProxy } from '@openagentix/runners';

/**
 * The egress proxy as its own service (docs/runners.md). Environment:
 *   OAX_EGRESS_PROXY_LISTEN            host:port, default 0.0.0.0:3128
 *   OAX_CONTAINER_EGRESS_GRANT_SECRET  HMAC key shared with the container runner (>= 32 chars)
 *   OAX_CONTAINER_EGRESS_ALLOW         operator ceiling for step egress (comma list; empty = nothing)
 *   OAX_CONTAINER_EGRESS_PRIVATE_ALLOW private CIDRs steps may reach where a rule matches
 *   OAX_AIRGAPPED, OAX_AIRGAPPED_ALLOW the process-wide air-gapped policy, applied on top
 * It must be attached to the internal node network and an egress network only.
 */
const list = (s: string | undefined) => (s ?? '').split(/[\s,]+/).filter(Boolean);
const [host = '0.0.0.0', port = '3128'] = (
  process.env.OAX_EGRESS_PROXY_LISTEN ?? '0.0.0.0:3128'
).split(/:(?=\d+$)/);
const airgapped = process.env.OAX_AIRGAPPED === 'true';
const proxy = new EgressProxy({
  secret: process.env.OAX_CONTAINER_EGRESS_GRANT_SECRET ?? '',
  ceiling: list(process.env.OAX_CONTAINER_EGRESS_ALLOW),
  privateAllow: list(process.env.OAX_CONTAINER_EGRESS_PRIVATE_ALLOW),
  ...(airgapped
    ? {
        outer: new EgressPolicy({
          airgapped: true,
          allow: parseAllowlist(process.env.OAX_AIRGAPPED_ALLOW),
        }),
      }
    : {}),
});
const addr = await proxy.listen(Number(port), host);
process.stderr.write(`egress proxy listening on ${addr.address}:${addr.port}\n`);
const stop = () => void proxy.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

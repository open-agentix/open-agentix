import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { OaxError, type EgressPolicy } from '@openagentix/core';

/**
 * Defence in depth for air-gapped mode: patches the lowest-level network entry points of the
 * process (TCP connect, DNS lookup, UDP send) so that NO library - HTTP clients, the AWS SDK,
 * LDAP, Kafka, OpenTelemetry - can reach a host that is not on the egress allowlist, even if a
 * code path forgot to consult the policy. Blocked attempts are recorded on the policy.
 */
export interface NetworkGuard {
  uninstall(): void;
}

type AnyFn = (...args: never[]) => unknown;

function hostPortOf(args: unknown[]): { host: string; port: number | null } | 'local' {
  let a0: unknown = args[0];
  if (Array.isArray(a0)) a0 = a0[0]; // internal normalised form [options, cb]
  if (a0 !== null && typeof a0 === 'object') {
    const o = a0 as { host?: string; hostname?: string; port?: number | string; path?: string };
    if (o.path && !o.port) return 'local';
    return {
      host: o.host ?? o.hostname ?? 'localhost',
      port: o.port === undefined ? null : Number(o.port),
    };
  }
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0)))
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a0) };
  return 'local'; // unix socket path
}

export function installNetworkGuard(policy: EgressPolicy): NetworkGuard {
  const restore: Array<() => void> = [];
  const patch = <T extends object>(obj: T, key: keyof T & string, wrap: (orig: AnyFn) => AnyFn) => {
    const orig = obj[key] as unknown as AnyFn;
    (obj as Record<string, unknown>)[key] = wrap(orig);
    restore.push(() => {
      (obj as Record<string, unknown>)[key] = orig;
    });
  };

  patch(
    net.Socket.prototype,
    'connect',
    (orig) =>
      function (this: net.Socket, ...args: never[]) {
        const target = hostPortOf(args as unknown[]);
        if (target !== 'local' && !policy.isAllowed(target.host, target.port)) {
          policy.record(target.host, target.port, 'tcp-connect');
          const err = new OaxError(
            'egress_denied',
            `air-gapped: TCP connect to ${target.host}${target.port ? `:${target.port}` : ''} blocked`,
          );
          process.nextTick(() => this.destroy(err));
          return this;
        }
        return orig.apply(this, args);
      } as AnyFn,
  );

  const lookupDenied = (host: string) => {
    policy.record(host, null, 'dns-lookup');
    return new OaxError('egress_denied', `air-gapped: DNS lookup of ${host} blocked`);
  };
  patch(
    dns,
    'lookup',
    (orig) =>
      function (this: unknown, ...args: never[]) {
        const host = args[0] as unknown as string;
        if (typeof host === 'string' && host !== '' && !net.isIP(host) && !policy.isAllowed(host)) {
          const cb = args[args.length - 1] as unknown as (e: Error) => void;
          process.nextTick(() => cb(lookupDenied(host)));
          return {};
        }
        return orig.apply(this, args);
      } as AnyFn,
  );
  patch(
    dns.promises,
    'lookup',
    (orig) =>
      ((host: string, ...rest: never[]) => {
        if (host && !net.isIP(host) && !policy.isAllowed(host))
          return Promise.reject(lookupDenied(host));
        return orig(host as never, ...rest);
      }) as AnyFn,
  );

  const udpDenied = (host: string, port: number | null) => {
    policy.record(host, port, 'udp');
    return new OaxError('egress_denied', `air-gapped: UDP to ${host} blocked`);
  };
  patch(
    dgram.Socket.prototype,
    'send',
    (orig) =>
      function (this: dgram.Socket, ...args: never[]) {
        // send(msg, [offset, length,] port, address[, cb]) - the address is the last string argument
        const list = args as unknown[];
        const addrIdx = list.findLastIndex((x) => typeof x === 'string');
        if (addrIdx < 1 || typeof list[addrIdx - 1] !== 'number') return orig.apply(this, args);
        const host = list[addrIdx] as string;
        const port = list[addrIdx - 1] as number;
        if (!policy.isAllowed(host, port)) throw udpDenied(host, port);
        return orig.apply(this, args);
      } as AnyFn,
  );

  return {
    uninstall() {
      for (const r of restore.reverse()) r();
      restore.length = 0;
    },
  };
}

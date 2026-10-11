import { randomBytes, randomUUID } from 'node:crypto';
import { ContainerRunner, EgressProxy } from '@openagentix/runners';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENABLED,
  ENGINE_URL,
  IMAGE,
  Lab,
  RAW_SOCKET,
  docker,
  type LabServer,
} from './engine-lab.js';

/**
 * ADR 0016 section 10, "Egress, zero unexpected connections", on a REAL container engine
 * (opt-in: OAX_TEST_DOCKER=1, see engine-lab.ts; never part of the default run).
 *
 * The run node is a real container started by the real `ContainerRunner` on a real `internal`
 * network, behind the real `EgressProxy` (this process, attached to the node network). Inside the
 * node a probe plays the three parties of one step with separate processes:
 *   toolbox  a binary of the step: holds the step's own proxy account
 *   A        a stdio MCP server with egress "a.s8.test": holds only its own account
 *   B        a stdio MCP server without egress: gets no proxy and no network at all
 * Upstreams are three servers on a second network: "a" and "toolbox" (allowed) and a canary that
 * nothing may ever reach. The assertions count connections: every server's hit list, the proxy's
 * per-account tunnel counts and its denials.
 *
 * What this does NOT run: the platform's own run-node program (it needs the worker image); the
 * probe stands in for it and receives exactly the bytes the runner writes on stdin. How the real
 * worker splits those accounts between children is covered by mcp-stdio-egress.test.ts with real
 * child processes.
 */
const NODE_TOKEN = `oaxrt.CANARY${randomBytes(9).toString('hex')}.sig`;

/** The probe: runs in the node container as "node -e". Prints one `RESULT {json}` line. */
const probe = (t: { canaryIp: string; upAIp: string; tokenSuffix: string }) => `
const net = require('node:net');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const CHILD = ${JSON.stringify(CHILD)};

const lines = [];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split('\\n');
  buf = parts.pop();
  lines.push(...parts);
  if (lines.length >= 4) void main();
});
let started = false;
const run = (name, proxy, plan) => new Promise((resolve) => {
  const env = { PLAN: JSON.stringify(plan) };
  if (proxy) env.HTTPS_PROXY = proxy;
  const c = spawn(process.execPath, ['-e', CHILD], { env });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.on('close', () => { try { resolve([name, JSON.parse(out.trim().split('\\n').pop())]); } catch (e) { resolve([name, { error: String(e), out }]); } });
});
async function main() {
  if (started) return; started = true;
  const token = lines[0];
  const stepProxy = lines[2];
  const servers = Object.fromEntries(lines.slice(3).map((l) => l.split(' ')));
  const results = Object.fromEntries(await Promise.all([
    run('toolbox', stepProxy, { connect: ['toolbox.s8.test', 'a.s8.test', 'canary.s8.test'] }),
    run('A', servers.a, { connect: ['a.s8.test', 'toolbox.s8.test', 'canary.s8.test', '${t.canaryIp}'] }),
    run('B', '', {
      direct: ['${t.canaryIp}', '${t.upAIp}', '1.1.1.1', '8.8.8.8'],
      resolve: ['a.s8.test', 'example.com', 'canary.s8.test'],
    }),
  ]));
  // the node itself: the token is neither in this environment nor on any command line
  const env = fs.readFileSync('/proc/self/environ', 'utf8');
  const cmdlines = fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p)).map((p) => {
    try { return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'); } catch { return ''; }
  }).join('\\n');
  const canary = token.split('.')[1];
  results.node = {
    tokenInEnv: env.includes(canary),
    tokenInCmdlines: cmdlines.includes(canary),
    stepProxyInEnv: stepProxy.length > 8 && env.includes(stepProxy.split('@')[0].slice(-12)),
    tokenSeenOnStdin: token.endsWith('${t.tokenSuffix}'),
    bundleMarker: lines[1],
    serverAccounts: Object.keys(servers),
  };
  console.log('RESULT ' + JSON.stringify(results));
  process.exit(0);
}
`;

/** One simulated process: a plan of CONNECTs through its proxy, raw sockets and name lookups. */
const CHILD = `
const net = require('node:net');
const dns = require('node:dns').promises;
const plan = JSON.parse(process.env.PLAN);
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const out = { connect: {}, direct: {}, resolve: {}, hadProxyEnv: !!proxy };
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
const via = (target) => new Promise((resolve) => {
  const s = net.connect(Number(proxy.port), proxy.hostname);
  let data = '';
  s.setTimeout(6000, () => { s.destroy(); resolve('timeout'); });
  s.on('error', (e) => resolve('error:' + e.code));
  s.on('connect', () => {
    const user = decodeURIComponent(proxy.username), pass = decodeURIComponent(proxy.password);
    s.write('CONNECT ' + target + ':443 HTTP/1.1\\r\\nHost: ' + target + ':443\\r\\nProxy-Authorization: Basic ' +
      Buffer.from(user + ':' + pass).toString('base64') + '\\r\\n\\r\\n');
  });
  let tunnelled = false;
  s.on('data', (d) => {
    data += d;
    if (!tunnelled && data.includes('\\r\\n\\r\\n')) {
      const status = data.split(' ')[1];
      if (status !== '200') { s.destroy(); return resolve(status); }
      tunnelled = true; data = '';
      s.write('GET /hit HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n');
    } else if (tunnelled && data.includes('\\r\\n')) { s.destroy(); resolve('200 tunnel, upstream ' + data.split(' ')[1]); }
  });
});
const raw = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: host === '8.8.8.8' ? 53 : 443 });
  s.setTimeout(2500, () => { s.destroy(); resolve('timeout'); });
  s.on('connect', () => { s.destroy(); resolve('CONNECTED'); });
  s.on('error', (e) => resolve('error:' + e.code));
});
(async () => {
  for (const t of plan.connect ?? []) out.connect[t] = proxy ? await via(t) : 'no proxy';
  for (const t of plan.direct ?? []) out.direct[t] = await raw(t);
  for (const t of plan.resolve ?? []) out.resolve[t] = await withTimeout(dns.lookup(t).then(() => 'RESOLVED', (e) => 'error:' + e.code), 6000);
  console.log(JSON.stringify(out));
})();
`;

describe.skipIf(!ENABLED)('egress of a real run node (OAX_TEST_DOCKER=1)', () => {
  const lab = new Lab();
  let proxy: EgressProxy;
  let upA: LabServer;
  let upT: LabServer;
  let canary: LabServer;
  let results: Record<string, Record<string, unknown>> = {};
  let inspectJson = '';
  let logs = '';
  const nodeId = randomUUID();
  const grantSecret = randomBytes(24).toString('hex');

  beforeAll(async () => {
    const nodes = lab.network('nodes', { internal: true });
    const out = lab.network('upstream');
    upA = await lab.server('up-a', out.name, { dataPort: 443 });
    upT = await lab.server('up-t', out.name, { dataPort: 443 });
    canary = await lab.server('canary', out.name, { dataPort: 443 });
    const names: Record<string, string> = {
      'a.s8.test': upA.ip,
      'toolbox.s8.test': upT.ip,
      'canary.s8.test': canary.ip,
    };
    proxy = new EgressProxy({
      secret: grantSecret,
      ceiling: ['*.s8.test'],
      // Only the two intended upstreams are opened; the canary is a private address as well.
      privateAllow: [`${upA.ip}/32`, `${upT.ip}/32`],
      resolve: async (h) => {
        const ip = names[h];
        if (!ip) throw new Error('nxdomain');
        return [ip];
      },
    });
    await proxy.listen(3128, '0.0.0.0');

    const runner = new ContainerRunner({
      engineUrl: ENGINE_URL,
      allowRawSocket: RAW_SOCKET,
      image: IMAGE,
      network: nodes.name,
      egressProxyUrl: `http://${nodes.selfIp}:3128`,
      egressGrantSecret: grantSecret,
      egressAllow: ['*.s8.test'],
      command: [
        'node',
        '-e',
        probe({ canaryIp: canary.ip, upAIp: upA.ip, tokenSuffix: NODE_TOKEN.slice(-6) }),
      ],
      workingDir: '/',
      uid: 10001,
      memoryMb: 256,
      instanceId: lab.prefix.replace('oax-s8-', 's8-'),
    });
    const handle = await runner.startNode({
      runId: randomUUID(),
      nodeId,
      steps: ['step'],
      image: IMAGE,
      controlUrl: 'http://api:8080',
      runToken: NODE_TOKEN,
      limits: { cpus: 1, memoryMb: 256, timeoutSeconds: 90, pids: 128 },
      egress: ['toolbox.s8.test'],
      mcpEgress: [{ server: 'a', egress: ['a.s8.test'] }],
    });
    const exit = await handle.wait();
    const cname = `oax-node-${nodeId}`;
    logs = docker('logs', cname);
    inspectJson = docker('inspect', cname);
    await handle.stop('step_end');
    expect(exit.exitCode, logs).toBe(0);
    const line = logs.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, logs).toBeDefined();
    results = JSON.parse(line!.slice(7));
  }, 180_000);

  afterAll(async () => {
    await proxy?.close();
    lab.cleanup();
  });

  it('a step toolbox binary reaches only its own destination', () => {
    expect(results.toolbox.hadProxyEnv).toBe(true);
    expect(results.toolbox.connect['toolbox.s8.test']).toBe('200 tunnel, upstream 404');
    expect(results.toolbox.connect['a.s8.test']).toBe('403');
    expect(results.toolbox.connect['canary.s8.test']).toBe('403');
  });

  it('stdio server A reaches only its own host with its own account', () => {
    expect(results.A.connect['a.s8.test']).toBe('200 tunnel, upstream 404');
    expect(results.A.connect['toolbox.s8.test']).toBe('403');
    expect(results.A.connect['canary.s8.test']).toBe('403');
    expect(results.A.connect[canary.ip]).toBe('403');
  });

  it('stdio server B without egress has no proxy, no route and no name resolution', () => {
    expect(results.B.hadProxyEnv).toBe(false);
    for (const [target, verdict] of Object.entries<string>(results.B.direct))
      expect(verdict, target).toMatch(/^(error:|timeout)/);
    for (const [name, verdict] of Object.entries<string>(results.B.resolve))
      expect(verdict, name).toMatch(/^error:/);
  });

  it('the proxy log shows exactly the expected tunnels and nothing for B', () => {
    const counts = Object.fromEntries(proxy.connectionCounts());
    expect(counts).toEqual({ [nodeId]: 1, [`${nodeId}.a`]: 1 });
    const denials = proxy.recentDenials();
    expect(denials.length).toBe(5);
    expect(new Set(denials.map((d) => d.reason))).toEqual(new Set(['not_allowed']));
    for (const d of denials) expect([nodeId, `${nodeId}.a`]).toContain(d.nodeId);
  });

  it('the upstream servers saw exactly the expected requests; the canary saw none', async () => {
    expect((await upA.hits()).map((h) => `${h.method} ${h.url}`)).toEqual(['GET /hit']);
    expect((await upT.hits()).map((h) => `${h.method} ${h.url}`)).toEqual(['GET /hit']);
    expect(await canary.hits()).toEqual([]);
  });

  it('the run token never reaches the node environment, command lines, inspect output or logs', () => {
    expect(results.node.tokenSeenOnStdin).toBe(true);
    expect(results.node.tokenInEnv).toBe(false);
    expect(results.node.tokenInCmdlines).toBe(false);
    const canaryPart = NODE_TOKEN.split('.')[1]!;
    expect(inspectJson).not.toContain(canaryPart);
    expect(logs).not.toContain(canaryPart);
    // the proxy grants (signed secrets) are on stdin only as well
    expect(inspectJson).not.toContain(grantSecret);
    // the probe's own source mentions proxy variables, so look at the engine's Env list instead
    const env = (JSON.parse(inspectJson)[0].Config.Env as string[]).join('\n');
    expect(env).not.toMatch(/PROXY|oaxrt|egress/i);
    expect(logs).not.toMatch(/Basic [A-Za-z0-9+/=]{20,}/);
  });

  it('the node got the bundle marker and one account per server, nothing else', () => {
    expect(results.node.bundleMarker).toBe('oax-bundle:v3');
    expect(results.node.serverAccounts).toEqual(['a']);
  });
});

describe('opt-in marker (egress)', () => {
  it(`is ${ENABLED ? 'enabled' : 'skipped (set OAX_TEST_DOCKER=1 and OAX_TEST_IMAGE)'}`, () => {
    expect(typeof ENABLED).toBe('boolean');
  });
});

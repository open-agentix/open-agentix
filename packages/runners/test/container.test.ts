import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ContainerRunner,
  assertSafeCreateBody,
  proxyUrlWithCredentials,
  verifyEgressGrant,
  type ContainerRunnerConfigInput,
  type EngineHijack,
  type EngineRequest,
  type EngineTransport,
  type RunNodeSpec,
} from '../src/index.js';

const IMG = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const TOOLBOX_IMG = `ghcr.io/open-agentix/toolbox-trivy@sha256:${'b'.repeat(64)}`;
const CID = 'c'.repeat(64);
const NODE = '11111111-2222-4333-8444-555555555555';
const RUN = '99999999-2222-4333-8444-555555555555';

const baseConfig: ContainerRunnerConfigInput = {
  engineUrl: 'http://socket-proxy:2375',
  image: IMG,
  toolboxImages: { trivy: TOOLBOX_IMG },
  network: 'oax-nodes',
};

const spec = (over: Partial<RunNodeSpec> = {}): RunNodeSpec => ({
  runId: RUN,
  nodeId: NODE,
  steps: ['triage'],
  image: IMG,
  controlUrl: 'http://api:8080',
  runToken: 'oaxrt.payload.signature',
  limits: { cpus: 0.5, memoryMb: 256, timeoutSeconds: 30, pids: 64 },
  egress: [],
  ...over,
});

interface FakeEngine {
  transport: EngineTransport;
  hijack: EngineHijack;
  calls: EngineRequest[];
  created: Record<string, unknown>[];
  /** What was written to the container's stdin, per attach (null while still open). */
  stdin: (string | null)[];
  attached: string[];
  /** Resolves the pending `wait` with an exit code. */
  exit(code: number): void;
  removed(): boolean;
  failOn?: string;
}

function fakeEngine(opts: { internal?: boolean; failOn?: string } = {}): FakeEngine {
  const calls: EngineRequest[] = [];
  const created: Record<string, unknown>[] = [];
  const stdin: (string | null)[] = [];
  const attached: string[] = [];
  let release: ((code: number) => void) | null = null;
  let removed = false;
  const transport: EngineTransport = (req) => {
    calls.push(req);
    const json = (status: number, body: unknown) =>
      Promise.resolve({ status, body: Buffer.from(JSON.stringify(body)) });
    const p = req.path.replace('/v1.43', '');
    if (opts.failOn && p.includes(opts.failOn)) return json(500, { message: 'boom' });
    if (p.startsWith('/networks/')) return json(200, { Internal: opts.internal ?? true });
    if (p.startsWith('/containers/create')) {
      created.push(JSON.parse(req.body!.toString()) as Record<string, unknown>);
      return json(201, { Id: CID });
    }
    if (p.endsWith('/wait'))
      return new Promise((resolve, reject) => {
        if (req.signal?.aborted) return reject(new Error('aborted'));
        release = (code) =>
          resolve({ status: 200, body: Buffer.from(JSON.stringify({ StatusCode: code })) });
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    if (req.method === 'DELETE') removed = true;
    return json(204, {});
  };
  const hijack: EngineHijack = async (req) => {
    if (opts.failOn && req.path.includes(opts.failOn)) throw new Error('attach refused');
    attached.push(req.path.replace('/v1.43', ''));
    const idx = stdin.push(null) - 1;
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    sink.on('end', () => (stdin[idx] = Buffer.concat(chunks).toString()));
    return sink;
  };
  return {
    transport,
    hijack,
    calls,
    created,
    stdin,
    attached,
    exit: (c) => release?.(c),
    removed: () => removed,
  };
}

const runner = (e: FakeEngine, cfg: Partial<ContainerRunnerConfigInput> = {}) =>
  new ContainerRunner({ ...baseConfig, ...cfg }, { transport: e.transport, hijack: e.hijack });

const GRANT_SECRET = 'g'.repeat(40);
const withEgress: Partial<ContainerRunnerConfigInput> = {
  egressProxyUrl: 'http://egress-proxy:3128',
  egressGrantSecret: GRANT_SECRET,
  egressAllow: ['jira.example.com', '*.corp.example'],
};

const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as { code?: string }).code;

describe('container runner configuration', () => {
  it('requires a digest-pinned image and an engine URL', () => {
    expect(() => new ContainerRunner({ ...baseConfig, image: 'node:22-alpine' })).toThrow();
    expect(() => new ContainerRunner({ ...baseConfig, image: 'node@sha256:abc' })).toThrow();
    expect(
      () => new ContainerRunner({ ...baseConfig, toolboxImages: { x: 'git:latest' } }),
    ).toThrow();
    expect(() => new ContainerRunner({ ...baseConfig, engineUrl: undefined as never })).toThrow();
  });
  it('refuses the raw Docker socket unless it is explicitly allowed (and then flags it)', () => {
    const raw = { ...baseConfig, engineUrl: 'unix:///var/run/docker.sock' };
    expect(() => new ContainerRunner(raw)).toThrow(/raw Docker socket/);
    const r = new ContainerRunner({ ...raw, allowRawSocket: true });
    expect(r.unsafeSocket).toBe(true);
    expect(new ContainerRunner(baseConfig).unsafeSocket).toBe(false);
    expect(
      new ContainerRunner({ ...baseConfig, engineUrl: 'unix:///run/user/1000/podman/podman.sock' })
        .unsafeSocket,
    ).toBe(false);
  });
  it('needs the proxy URL and the grant secret together, and refuses root uids', () => {
    expect(
      () => new ContainerRunner({ ...baseConfig, egressProxyUrl: 'http://egress-proxy:3128' }),
    ).toThrow(/together/);
    expect(() => new ContainerRunner({ ...baseConfig, egressGrantSecret: GRANT_SECRET })).toThrow();
    expect(() => new ContainerRunner({ ...baseConfig, egressAllow: ['*.com'] })).toThrow(
      /two labels/,
    );
    expect(() => new ContainerRunner({ ...baseConfig, uid: 0 })).toThrow();
  });
  it('is not a whole-run runner', async () => {
    await expect(runner(fakeEngine()).execute({} as never, {} as never)).rejects.toMatchObject({
      code: 'runner_not_whole_run',
    });
  });
  it('maps toolboxes to images and fails closed on unknown ones', () => {
    const r = runner(fakeEngine());
    expect(r.imageFor(undefined)).toBe(IMG);
    expect(r.imageFor('trivy')).toBe(TOOLBOX_IMG);
    expect(() => r.imageFor('git+node')).toThrow(/no image is configured for toolbox/);
  });
});

describe('create options (hardening)', () => {
  it('builds a hardened container: non-root, read-only, no caps, limits, tmpfs, internal network', () => {
    const body = runner(fakeEngine()).buildCreateBody(spec());
    const h = body.HostConfig;
    expect(body.User).toBe('10001:10001');
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Privileged).toBe(false);
    expect(h.NetworkMode).toBe('oax-nodes');
    expect(h.Memory).toBe(256 * 1024 * 1024);
    expect(h.MemorySwap).toBe(h.Memory);
    expect(h.NanoCpus).toBe(5e8);
    expect(h.PidsLimit).toBe(64);
    expect(Object.keys(h.Tmpfs as object).sort()).toEqual(['/run/oax', '/tmp']);
    expect((h.Tmpfs as Record<string, string>)['/run/oax']).toContain('mode=0700');
    expect((h.Tmpfs as Record<string, string>)['/tmp']).toContain('noexec');
    for (const forbidden of ['Binds', 'Devices', 'CapAdd', 'Mounts', 'PidMode', 'UsernsMode'])
      expect(h).not.toHaveProperty(forbidden);
    expect(body.Labels['io.openagentix.run-node']).toBe('true');
    expect(() => assertSafeCreateBody(body)).not.toThrow();
  });
  it('never puts the token or any secret into the environment or the command line', () => {
    const body = runner(fakeEngine()).buildCreateBody(spec());
    const dump = JSON.stringify(body);
    expect(dump).not.toContain('oaxrt.');
    // the node reads the token from stdin, which is not part of the create options
    expect(body.Env).toContain('OAX_RUN_TOKEN_FILE=/dev/stdin');
    expect(body.OpenStdin).toBe(true);
    expect(body.StdinOnce).toBe(true);
    expect(body.Env.some((e) => /SECRET|PASSWORD|API_KEY/i.test(e))).toBe(false);
  });
  it('clamps limits to the configured maxima', () => {
    const body = runner(fakeEngine(), {
      maxCpus: 1,
      maxMemoryMb: 128,
      maxPids: 32,
    }).buildCreateBody(
      spec({ limits: { cpus: 8, memoryMb: 8192, timeoutSeconds: 5, pids: 9999 } }),
    );
    expect(body.HostConfig.Memory).toBe(128 * 1024 * 1024);
    expect(body.HostConfig.NanoCpus).toBe(1e9);
    expect(body.HostConfig.PidsLimit).toBe(32);
  });

  type Body = {
    HostConfig: Record<string, unknown>;
    Env: string[];
    [k: string]: unknown;
  };
  const good = () => runner(fakeEngine()).buildCreateBody(spec());
  const mutate = (fn: (b: Body) => void) => {
    const b = structuredClone(good()) as Body;
    fn(b);
    return b;
  };
  it.each([
    ['privileged', (b: Body) => (b.HostConfig.Privileged = true)],
    [
      'bind mount',
      (b: Body) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
    ],
    [
      'docker.sock mount',
      (b: Body) => (b.HostConfig.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock' }]),
    ],
    ['device', (b: Body) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }])],
    ['capability add', (b: Body) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['host network', (b: Body) => (b.HostConfig.NetworkMode = 'host')],
    ['default bridge', (b: Body) => (b.HostConfig.NetworkMode = 'bridge')],
    ['container network', (b: Body) => (b.HostConfig.NetworkMode = 'container:abc')],
    ['host pid', (b: Body) => (b.HostConfig.PidMode = 'host')],
    ['host ipc', (b: Body) => (b.HostConfig.IpcMode = 'host')],
    ['host userns', (b: Body) => (b.HostConfig.UsernsMode = 'host')],
    ['writable rootfs', (b: Body) => (b.HostConfig.ReadonlyRootfs = false)],
    ['caps not dropped', (b: Body) => (b.HostConfig.CapDrop = [])],
    ['no-new-privileges missing', (b: Body) => (b.HostConfig.SecurityOpt = [])],
    [
      'seccomp unconfined',
      (b: Body) => (b.HostConfig.SecurityOpt = ['no-new-privileges:true', 'seccomp=unconfined']),
    ],
    ['no memory limit', (b: Body) => (b.HostConfig.Memory = 0)],
    ['no cpu limit', (b: Body) => delete b.HostConfig.NanoCpus],
    ['no pids limit', (b: Body) => (b.HostConfig.PidsLimit = 0)],
    ['sysctl', (b: Body) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
    ['volumes', (b: Body) => (b.Volumes = { '/data': {} })],
    ['volumes-from', (b: Body) => (b.HostConfig.VolumesFrom = ['other'])],
    ['root user', (b: Body) => (b.User = 'root')],
    ['uid 0', (b: Body) => (b.User = '0:0')],
    ['empty user', (b: Body) => (b.User = '')],
    ['tag-only image', (b: Body) => (b.Image = 'node:latest')],
    ['token in env', (b: Body) => b.Env.push('OAX_RUN_TOKEN=oaxrt.a.b')],
    ['token value in env', (b: Body) => b.Env.push('X=oaxrt.a.b')],
    ['secret env', (b: Body) => b.Env.push('OAX_SECRET_JIRA=abc')],
  ])('refuses %s', (_name, fn) => {
    expect(() => assertSafeCreateBody(mutate(fn))).toThrow(/unsafe options/);
  });
  it('reports every problem and has a stable error code', () => {
    try {
      assertSafeCreateBody({ HostConfig: { Privileged: true, Binds: ['/:/host'] } });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('container_options_refused');
      expect((e as { details: string[] }).details).toContain('privileged');
      expect((e as { details: string[] }).details).toContain('HostConfig.Binds');
    }
  });
});

describe('startNode: validation fails closed before anything is created', () => {
  const cases: [string, Partial<RunNodeSpec>, string][] = [
    ['unpinned image', { image: 'ghcr.io/x/worker:latest' }, 'image_not_allowed'],
    ['foreign digest', { image: `evil/x@sha256:${'d'.repeat(64)}` }, 'image_not_allowed'],
    ['bad node id', { nodeId: '../../etc' }, 'run_node_invalid'],
    ['bad run id', { runId: 'x' }, 'run_node_invalid'],
    ['no steps', { steps: [] }, 'run_node_invalid'],
    ['bad step id', { steps: ['A B'] }, 'run_node_invalid'],
    ['not a run token', { runToken: 'secret-value' }, 'run_node_invalid'],
    ['bad control url', { controlUrl: 'file:///etc/passwd' }, 'run_node_invalid'],
    [
      'zero timeout',
      { limits: { cpus: 1, memoryMb: 128, timeoutSeconds: 0, pids: 1 } },
      'run_node_invalid',
    ],
    ['egress without a proxy', { egress: ['jira.example.com'] }, 'egress_proxy_missing'],
  ];
  it.each(cases)('%s', async (_n, over, expected) => {
    const e = fakeEngine();
    expect(await code(runner(e).startNode(spec(over)))).toBe(expected);
    expect(e.calls).toHaveLength(0);
  });
  it('refuses a network that is not internal and creates nothing', async () => {
    const e = fakeEngine({ internal: false });
    expect(await code(runner(e).startNode(spec()))).toBe('network_not_internal');
    expect(e.created).toHaveLength(0);
  });
  it('honours an already aborted signal', async () => {
    const e = fakeEngine();
    const ac = new AbortController();
    ac.abort();
    await expect(runner(e).startNode(spec(), { signal: ac.signal })).rejects.toBeDefined();
    expect(e.calls).toHaveLength(0);
  });
});

describe('startNode: lifecycle', () => {
  it('attaches stdin before the start, sends the token only there, and removes at the end', async () => {
    const e = fakeEngine();
    const handle = await runner(e).startNode(spec());
    expect(handle.nodeId).toBe(NODE);
    const order = e.calls.map((c) => c.path.replace('/v1.43', '').replace(CID, 'ID').split('?')[0]);
    expect(order).toEqual(['/networks/oax-nodes', '/containers/create', '/containers/ID/start']);
    expect(e.calls[1]!.path).toContain(`name=oax-node-${NODE}`);
    // attach happens between create and start, so the node cannot miss its token
    expect(e.attached).toEqual([`/containers/${CID}/attach?stream=1&stdin=1`]);
    expect(e.stdin).toEqual(['oaxrt.payload.signature\n']); // written once, then EOF
    // the token is nowhere in what the engine can show through inspect
    for (const call of e.calls) expect(String(call.body ?? '')).not.toContain('oaxrt.');
    const waiting = handle.wait();
    e.exit(0);
    expect(await waiting).toEqual({ exitCode: 0 });
    await handle.stop('step_end');
    expect(e.removed()).toBe(true);
  });
  it('stop is idempotent and removes the container exactly once', async () => {
    const e = fakeEngine();
    const handle = await runner(e).startNode(spec());
    await Promise.all([handle.stop('step_end'), handle.stop('cancelled')]);
    await handle.stop('timeout');
    expect(e.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(e.calls.filter((c) => c.path.endsWith('/kill'))).toHaveLength(1);
  });
  it('kills the node when its timeout elapses and reports it', async () => {
    const e = fakeEngine();
    const handle = await runner(e).startNode(
      spec({ limits: { cpus: 1, memoryMb: 128, timeoutSeconds: 0.05, pids: 8 } }),
    );
    expect(await handle.wait()).toEqual({ exitCode: null, reason: 'timeout' });
    expect(e.removed()).toBe(true);
  });
  it('stops the node when the caller aborts', async () => {
    const e = fakeEngine();
    const ac = new AbortController();
    const handle = await runner(e).startNode(spec());
    const w = handle.wait(ac.signal);
    ac.abort();
    expect(await w).toEqual({ exitCode: null, reason: 'cancelled' });
    expect(e.removed()).toBe(true);
    const e2 = fakeEngine();
    const h2 = await runner(e2).startNode(spec());
    const pre = new AbortController();
    pre.abort();
    expect(await h2.wait(pre.signal)).toEqual({ exitCode: null, reason: 'cancelled' });
  });
  it('rethrows engine errors from wait that are not caused by us', async () => {
    const e = fakeEngine();
    const handle = await runner(e).startNode(spec());
    const failing = runner(fakeEngine({ failOn: '/wait' }));
    const h2 = await failing.startNode(spec());
    await expect(h2.wait()).rejects.toThrow(/HTTP 500/);
    await handle.stop('step_end');
  });
  it.each(['/start', '/attach', '/create'])('cleans up when %s fails', async (failOn) => {
    const e = fakeEngine({ failOn });
    await expect(runner(e).startNode(spec())).rejects.toThrow(/HTTP 500|attach refused/);
    // anything that was created is force-removed again
    expect(e.removed()).toBe(failOn !== '/create');
  });
  it('hands the node a signed, expiring egress grant on stdin and nothing in the create options', async () => {
    const e = fakeEngine();
    const handle = await runner(e, withEgress).startNode(spec({ egress: ['jira.example.com'] }));
    await new Promise((r) => setTimeout(r, 10));
    const [lines] = e.stdin as string[];
    const [token, proxyLine] = lines!.split('\n');
    expect(token).toBe('oaxrt.payload.signature');
    const u = new URL(proxyLine!);
    expect(decodeURIComponent(u.username)).toBe(NODE);
    const claims = verifyEgressGrant(GRANT_SECRET, NODE, decodeURIComponent(u.password));
    expect(claims).toMatchObject({ n: NODE, e: ['jira.example.com'] });
    // lifetime: step timeout + 60 s
    expect(claims!.x - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(90);
    expect(JSON.stringify(e.created[0])).not.toMatch(/egress-proxy|3128/);
    await handle.stop('step_end');
  });
  it('refuses step egress outside the operator ceiling before anything is created', async () => {
    for (const egress of [
      'evil.example.com',
      '*.example.com',
      '10.0.0.0/8',
      '0.0.0.0/1',
      '*.com',
      'jira.example.com:22',
    ]) {
      const e = fakeEngine();
      expect(await code(runner(e, withEgress).startNode(spec({ egress: [egress] })))).toMatch(
        /egress_invalid/,
      );
      expect(e.calls).toHaveLength(0);
    }
    // no ceiling at all: no step may declare egress
    const none = fakeEngine();
    const r = runner(none, {
      egressProxyUrl: 'http://egress-proxy:3128',
      egressGrantSecret: GRANT_SECRET,
    });
    expect(await code(r.startNode(spec({ egress: ['jira.example.com'] })))).toBe('egress_invalid');
  });
  it('a step without egress gets no proxy line at all', async () => {
    const e = fakeEngine();
    const h = await runner(e, withEgress).startNode(spec());
    await new Promise((r) => setTimeout(r, 10));
    expect(e.stdin).toEqual(['oaxrt.payload.signature\n']);
    await h.stop('step_end');
  });
});

describe('hard lifetime and orphan reaper', () => {
  it('labels every node with an expiry and tells it its deadline', () => {
    const body = runner(fakeEngine()).buildCreateBody(spec());
    const expires = Number(body.Labels['io.openagentix.expires']);
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(30);
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30 + 90);
    expect(body.Env).toContain('OAX_NODE_DEADLINE_SECONDS=60');
  });
  it('filters on both labels, removes only expired ones and skips unparsable expiries', async () => {
    const removed: string[] = [];
    const queries: string[] = [];
    const now = 1_000_000_000_000;
    const L = (expires: string | undefined, over: Record<string, string> = {}) => ({
      'io.openagentix.run-node': 'true',
      'io.openagentix.instance': 'default',
      ...(expires === undefined ? {} : { 'io.openagentix.expires': expires }),
      ...over,
    });
    const transport: EngineTransport = async (req) => {
      const p = req.path.replace('/v1.43', '');
      if (p.startsWith('/containers/json')) {
        queries.push(decodeURIComponent(p.split('filters=')[1]!));
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify([
              { Id: 'a'.repeat(64), Labels: L(String(now / 1000 - 5)) }, // expired -> removed
              { Id: 'b'.repeat(64), Labels: L(String(now / 1000 + 500)) }, // live -> kept
              { Id: 'c'.repeat(64), Labels: L(undefined) }, // no expiry -> skipped
              { Id: 'd'.repeat(64), Labels: L('not-a-number') }, // NaN -> skipped
              { Id: 'e'.repeat(64), Labels: L('') }, // empty -> skipped (Number('') is 0)
              {
                Id: 'f'.repeat(64),
                Labels: L(String(now / 1000 - 5), { 'io.openagentix.instance': 'other' }),
              }, // foreign installation
              {
                Id: '1'.repeat(64),
                Labels: L(String(now / 1000 - 5), { 'io.openagentix.run-node': 'false' }),
              },
            ]),
          ),
        };
      }
      if (req.method === 'DELETE') removed.push(p.split('/')[2]!.split('?')[0]!);
      return { status: 204, body: Buffer.alloc(0) };
    };
    const r = new ContainerRunner(baseConfig, { transport });
    expect(await r.reapOrphans(now)).toBe(1);
    expect(removed).toEqual(['a'.repeat(64)]);
    expect(JSON.parse(queries[0]!)).toEqual({
      label: ['io.openagentix.run-node=true', 'io.openagentix.instance=default'],
    });
    const other = new ContainerRunner({ ...baseConfig, instanceId: 'prod-1' }, { transport });
    await other.reapOrphans(now);
    expect(JSON.parse(queries[1]!).label[1]).toBe('io.openagentix.instance=prod-1');
  });
  it('labels nodes with the installation id', () => {
    expect(
      runner(fakeEngine(), { instanceId: 'prod-1' }).buildCreateBody(spec()).Labels[
        'io.openagentix.instance'
      ],
    ).toBe('prod-1');
    expect(() => new ContainerRunner({ ...baseConfig, instanceId: 'Bad Id' })).toThrow();
  });
});

describe('proxyUrlWithCredentials', () => {
  it('encodes the account into the URL', () => {
    expect(proxyUrlWithCredentials('http://w:3128', 'n-1', 'p@ss/w')).toBe(
      'http://n-1:p%40ss%2Fw@w:3128/',
    );
  });
});

describe('harness images and limits (DOG-1)', () => {
  const HARNESS_IMG = `ghcr.io/open-agentix/open-agentix-run-node-claude-code@sha256:${'c'.repeat(64)}`;
  const withHarness: Partial<ContainerRunnerConfigInput> = {
    harnessImages: { 'claude-code': HARNESS_IMG },
    maxMemoryMb: 4096,
  };

  it('maps a harness to its image and fails closed on an unconfigured one', () => {
    const r = runner(fakeEngine(), withHarness);
    expect(r.imageFor(undefined, 'claude-code')).toBe(HARNESS_IMG);
    // the harness image wins over the toolbox: one image per harness
    expect(r.imageFor('trivy', 'claude-code')).toBe(HARNESS_IMG);
    expect(() => r.imageFor(undefined, 'opencode')).toThrow(/no image is configured for harness/);
    try {
      r.imageFor(undefined, 'opencode');
    } catch (e) {
      expect((e as { code: string }).code).toBe('harness_image_unknown');
    }
    expect(r.allowedImages().has(HARNESS_IMG)).toBe(true);
  });

  it('accepts only known harness kinds and digest-pinned harness images', () => {
    expect(
      () => new ContainerRunner({ ...baseConfig, harnessImages: { 'claude-code': 'x:latest' } }),
    ).toThrow(/digest/);
    expect(
      () => new ContainerRunner({ ...baseConfig, harnessImages: { evil: HARNESS_IMG } as never }),
    ).toThrow();
  });

  it('gives harness steps their own memory and /tmp size, capped by the operator maximum', () => {
    const r = runner(fakeEngine(), withHarness);
    const body = r.buildCreateBody(spec({ image: HARNESS_IMG, harness: 'claude-code' }));
    expect(body.HostConfig.Memory).toBe(2048 * 1024 * 1024);
    expect((body.HostConfig.Tmpfs as Record<string, string>)['/tmp']).toContain('size=256m');
    expect(() => assertSafeCreateBody(body)).not.toThrow();
    const capped = runner(fakeEngine(), { ...withHarness, maxMemoryMb: 1024 }).buildCreateBody(
      spec({ image: HARNESS_IMG, harness: 'claude-code' }),
    );
    expect(capped.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    // ordinary nodes keep their defaults
    const plain = r.buildCreateBody(spec());
    expect(plain.HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect((plain.HostConfig.Tmpfs as Record<string, string>)['/tmp']).toContain('size=64m');
  });

  it('makes the /tmp sizes configurable', () => {
    const body = runner(fakeEngine(), {
      ...withHarness,
      tmpMb: 128,
      harnessTmpMb: 512,
      harnessMemoryMb: 3072,
    });
    expect(
      (body.buildCreateBody(spec()).HostConfig.Tmpfs as Record<string, string>)['/tmp'],
    ).toContain('size=128m');
    const h = body.buildCreateBody(spec({ image: HARNESS_IMG, harness: 'claude-code' }));
    expect((h.HostConfig.Tmpfs as Record<string, string>)['/tmp']).toContain('size=512m');
    expect(h.HostConfig.Memory).toBe(3072 * 1024 * 1024);
  });

  it('runs a harness step only on its own image and without egress by default', async () => {
    const r = runner(fakeEngine(), { ...withHarness, ...withEgress });
    expect(
      await code(r.startNode(spec({ harness: 'claude-code' }))), // default image, not the harness image
    ).toBe('image_not_allowed');
    expect(
      await code(
        r.startNode(
          spec({ image: HARNESS_IMG, harness: 'claude-code', egress: ['jira.example.com'] }),
        ),
      ),
    ).toBe('harness_egress_denied');
    const open = runner(fakeEngine(), {
      ...withHarness,
      ...withEgress,
      harnessEgressAllowed: true,
    });
    const h = await open.startNode(
      spec({ image: HARNESS_IMG, harness: 'claude-code', egress: ['jira.example.com'] }),
    );
    await h.stop('step_end');
    const ok = runner(fakeEngine(), withHarness);
    const h2 = await ok.startNode(spec({ image: HARNESS_IMG, harness: 'claude-code' }));
    await h2.stop('step_end');
  });
});

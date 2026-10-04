import { describe, expect, it } from 'vitest';
import {
  ContainerRunner,
  EgressProxy,
  assertSafeCreateBody,
  proxyUrlWithCredentials,
  type ContainerRunnerConfigInput,
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
  calls: EngineRequest[];
  created: Record<string, unknown>[];
  uploads: Buffer[];
  /** Resolves the pending `wait` with an exit code. */
  exit(code: number): void;
  removed(): boolean;
  failOn?: string;
}

function fakeEngine(opts: { internal?: boolean; failOn?: string } = {}): FakeEngine {
  const calls: EngineRequest[] = [];
  const created: Record<string, unknown>[] = [];
  const uploads: Buffer[] = [];
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
    if (p.endsWith('/archive?path=%2Frun%2Foax')) {
      uploads.push(req.body!);
      return json(200, {});
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
  return {
    transport,
    calls,
    created,
    uploads,
    exit: (c) => release?.(c),
    removed: () => removed,
  };
}

const runner = (
  e: FakeEngine,
  cfg: Partial<ContainerRunnerConfigInput> = {},
  proxy?: EgressProxy,
) =>
  new ContainerRunner(
    { ...baseConfig, ...cfg },
    { transport: e.transport, ...(proxy ? { egressProxy: proxy } : {}) },
  );

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
  it('refuses a proxy URL without a proxy and root uids', () => {
    expect(
      () => new ContainerRunner({ ...baseConfig, egressProxyUrl: 'http://worker:3128' }),
    ).toThrow(/no egress proxy/);
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
    const body = runner(fakeEngine()).buildCreateBody(spec(), false);
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
    const body = runner(fakeEngine()).buildCreateBody(spec(), true);
    const dump = JSON.stringify(body);
    expect(dump).not.toContain('oaxrt.');
    expect(body.Env).toContain('OAX_RUN_TOKEN_FILE=/run/oax/token');
    expect(body.Env).toContain('OAX_PROXY_URL_FILE=/run/oax/proxy-url');
    expect(body.Env.some((e) => /SECRET|PASSWORD|API_KEY/i.test(e))).toBe(false);
  });
  it('clamps limits to the configured maxima', () => {
    const body = runner(fakeEngine(), {
      maxCpus: 1,
      maxMemoryMb: 128,
      maxPids: 32,
    }).buildCreateBody(
      spec({ limits: { cpus: 8, memoryMb: 8192, timeoutSeconds: 5, pids: 9999 } }),
      false,
    );
    expect(body.HostConfig.Memory).toBe(128 * 1024 * 1024);
    expect(body.HostConfig.NanoCpus).toBe(1e9);
    expect(body.HostConfig.PidsLimit).toBe(32);
  });

  const good = () => runner(fakeEngine()).buildCreateBody(spec(), false);
  const mutate = (fn: (b: Record<string, any>) => void) => {
    const b = structuredClone(good()) as Record<string, any>;
    fn(b);
    return b;
  };
  it.each([
    ['privileged', (b: any) => (b.HostConfig.Privileged = true)],
    [
      'bind mount',
      (b: any) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
    ],
    [
      'docker.sock mount',
      (b: any) => (b.HostConfig.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock' }]),
    ],
    ['device', (b: any) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }])],
    ['capability add', (b: any) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['host network', (b: any) => (b.HostConfig.NetworkMode = 'host')],
    ['default bridge', (b: any) => (b.HostConfig.NetworkMode = 'bridge')],
    ['container network', (b: any) => (b.HostConfig.NetworkMode = 'container:abc')],
    ['host pid', (b: any) => (b.HostConfig.PidMode = 'host')],
    ['host ipc', (b: any) => (b.HostConfig.IpcMode = 'host')],
    ['host userns', (b: any) => (b.HostConfig.UsernsMode = 'host')],
    ['writable rootfs', (b: any) => (b.HostConfig.ReadonlyRootfs = false)],
    ['caps not dropped', (b: any) => (b.HostConfig.CapDrop = [])],
    ['no-new-privileges missing', (b: any) => (b.HostConfig.SecurityOpt = [])],
    [
      'seccomp unconfined',
      (b: any) => (b.HostConfig.SecurityOpt = ['no-new-privileges:true', 'seccomp=unconfined']),
    ],
    ['no memory limit', (b: any) => (b.HostConfig.Memory = 0)],
    ['no cpu limit', (b: any) => delete b.HostConfig.NanoCpus],
    ['no pids limit', (b: any) => (b.HostConfig.PidsLimit = 0)],
    ['sysctl', (b: any) => (b.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' })],
    ['volumes', (b: any) => (b.Volumes = { '/data': {} })],
    ['volumes-from', (b: any) => (b.HostConfig.VolumesFrom = ['other'])],
    ['root user', (b: any) => (b.User = 'root')],
    ['uid 0', (b: any) => (b.User = '0:0')],
    ['empty user', (b: any) => (b.User = '')],
    ['tag-only image', (b: any) => (b.Image = 'node:latest')],
    ['token in env', (b: any) => b.Env.push('OAX_RUN_TOKEN=oaxrt.a.b')],
    ['token value in env', (b: any) => b.Env.push('X=oaxrt.a.b')],
    ['secret env', (b: any) => b.Env.push('OAX_SECRET_JIRA=abc')],
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
  it('creates, starts, uploads the token as a file and never as env; removes at the end', async () => {
    const e = fakeEngine();
    const handle = await runner(e).startNode(spec());
    expect(handle.nodeId).toBe(NODE);
    const order = e.calls.map((c) => c.path.replace('/v1.43', '').replace(CID, 'ID').split('?')[0]);
    expect(order).toEqual([
      '/networks/oax-nodes',
      '/containers/create',
      '/containers/ID/start',
      '/containers/ID/archive',
    ]);
    expect(e.calls[1]!.path).toContain(`name=oax-node-${NODE}`);
    expect(JSON.stringify(e.created[0])).not.toContain('oaxrt.');
    const tar = e.uploads[0]!;
    expect(tar.subarray(0, 5).toString()).toBe('token');
    expect(tar.subarray(512, 512 + 'oaxrt.payload.signature'.length).toString()).toBe(
      'oaxrt.payload.signature',
    );
    expect(parseInt(tar.toString('ascii', 108, 115), 8)).toBe(10001); // owned by the node user
    expect(parseInt(tar.toString('ascii', 100, 107), 8)).toBe(0o400);
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
  it.each(['/start', '/archive', '/create'])('cleans up when %s fails', async (failOn) => {
    const e = fakeEngine({ failOn });
    await expect(runner(e).startNode(spec())).rejects.toThrow(/HTTP 500/);
    // anything that was created is force-removed again
    expect(e.removed()).toBe(failOn !== '/create');
  });
  it('registers the node with the egress proxy, hands it credentials as a file, and unregisters', async () => {
    const e = fakeEngine();
    const proxy = new EgressProxy();
    const r = runner(e, { egressProxyUrl: 'http://worker:3128' }, proxy);
    const handle = await r.startNode(spec({ egress: ['jira.example.com'] }));
    expect(proxy.registered).toBe(1);
    const tar = e.uploads[0]!;
    expect(tar.toString('latin1')).toContain('proxy-url');
    expect(tar.toString('latin1')).toContain(`http://${NODE}:`);
    expect(JSON.stringify(e.created[0])).not.toMatch(/worker:3128/);
    await handle.stop('step_end');
    expect(proxy.registered).toBe(0);
  });
  it('unregisters from the proxy when starting fails', async () => {
    const proxy = new EgressProxy();
    const r = runner(fakeEngine({ failOn: '/start' }), { egressProxyUrl: 'http://w:3128' }, proxy);
    await expect(r.startNode(spec({ egress: [] }))).rejects.toThrow();
    expect(proxy.registered).toBe(0);
  });
});

describe('proxyUrlWithCredentials', () => {
  it('encodes the account into the URL', () => {
    expect(proxyUrlWithCredentials('http://w:3128', 'n-1', 'p@ss/w')).toBe(
      'http://n-1:p%40ss%2Fw@w:3128/',
    );
  });
});

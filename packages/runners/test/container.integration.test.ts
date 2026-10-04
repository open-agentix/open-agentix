import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerRunner, type RunNodeSpec } from '../src/index.js';

/**
 * Opt-in integration test against a real Docker/Podman engine (`OAX_TEST_DOCKER=1`). It proves the
 * isolation properties on a real engine instead of a fake one:
 *
 *   OAX_TEST_DOCKER=1 \
 *   OAX_TEST_IMAGE=alpine@sha256:<digest of a local alpine image> \
 *   [OAX_TEST_ENGINE_URL=unix:///run/user/1000/podman/podman.sock] \
 *   pnpm vitest run packages/runners/test/container.integration.test.ts
 *
 * The image must already exist locally (the runner never pulls) and contain `sh`, `id`, `grep`,
 * `wget` and `ls` (alpine/busybox). The test creates and removes its own internal network. Against
 * the raw Docker socket it needs OAX_TEST_ALLOW_RAW_SOCKET=1 (a test-only opt-out of the guard).
 */
const enabled = process.env.OAX_TEST_DOCKER === '1' && !!process.env.OAX_TEST_IMAGE;
const IMAGE = process.env.OAX_TEST_IMAGE ?? '';
const NETWORK = `oax-it-${process.pid}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });

const newId = () =>
  `${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

/**
 * Runs inside the node. The token arrives on stdin (line 1); the exit code names the first failed
 * check (0 = every check held). EXPECT/FORBIDDEN come from the command prefix set by the test.
 */
const CHECKS = `
read -r TOKEN
[ "$(id -u)" != "0" ] || exit 10
( : > /probe ) 2>/dev/null && exit 11
[ ! -e /var/run/docker.sock ] || exit 12
[ ! -S /run/docker.sock ] || exit 13
case "$TOKEN" in oaxrt.*) ;; *) exit 14;; esac
grep -q ' /run/oax tmpfs ' /proc/mounts || exit 15
env | grep -q 'oaxrt\\.' && exit 16
case "$TOKEN" in "oaxrt.$EXPECT"*) ;; *) exit 17;; esac
case "$TOKEN" in *"$FORBIDDEN"*) exit 18;; esac
wget -q -T 3 -O /dev/null http://example.com && exit 19
wget -q -T 3 -O /dev/null http://1.1.1.1 && exit 19
[ "$(grep CapEff /proc/self/status | awk '{print $2}')" = "0000000000000000" ] || exit 20
exit 0
`;

describe.skipIf(!enabled)('container runner against a real engine (OAX_TEST_DOCKER=1)', () => {
  const runner = () =>
    new ContainerRunner({
      engineUrl: process.env.OAX_TEST_ENGINE_URL ?? 'unix:///var/run/docker.sock',
      allowRawSocket: process.env.OAX_TEST_ALLOW_RAW_SOCKET === '1',
      image: IMAGE,
      network: NETWORK,
      command: ['sh', '-c', CHECKS],
      workingDir: '/',
      uid: 10001,
    });
  const spec = (token: string, extra: Partial<RunNodeSpec> = {}): RunNodeSpec => ({
    runId: newId(),
    nodeId: newId(),
    steps: ['step'],
    image: IMAGE,
    controlUrl: 'http://api:8080',
    runToken: token,
    limits: { cpus: 0.5, memoryMb: 128, timeoutSeconds: 60, pids: 64 },
    egress: [],
    ...extra,
  });

  beforeAll(() => void docker('network', 'create', '--internal', NETWORK));
  afterAll(() => {
    try {
      docker('network', 'rm', NETWORK);
    } catch {
      // already gone
    }
  });

  it('every check holds inside the node and the container is gone afterwards', async () => {
    const r = runner();
    // Two nodes with different tokens: neither can read the other's.
    const specs = [spec('oaxrt.AAAAAAAA.sig'), spec('oaxrt.BBBBBBBB.sig')];
    const exits: (number | null)[] = [];
    for (const [i, s] of specs.entries()) {
      // The probe reads its expectations from the environment of the test process via the image
      // command; here they are baked into the command through the config instead.
      const checked = new ContainerRunner({
        ...r.config,
        command: [
          'sh',
          '-c',
          `EXPECT='${i === 0 ? 'AAAAAAAA' : 'BBBBBBBB'}' FORBIDDEN='${i === 0 ? 'BBBBBBBB' : 'AAAAAAAA'}'\n${CHECKS}`,
        ],
      });
      const handle = await checked.startNode(s);
      exits.push((await handle.wait()).exitCode);
      await handle.stop('step_end');
      // removed: the engine no longer knows the container
      expect(() => docker('inspect', `oax-node-${s.nodeId}`), 'container is gone').toThrow();
    }
    expect(exits).toEqual([0, 0]);
  });

  it('kills a node that outlives its timeout and removes it', async () => {
    const slow = new ContainerRunner({
      engineUrl: process.env.OAX_TEST_ENGINE_URL ?? 'unix:///var/run/docker.sock',
      allowRawSocket: process.env.OAX_TEST_ALLOW_RAW_SOCKET === '1',
      image: IMAGE,
      network: NETWORK,
      command: ['sh', '-c', 'sleep 60'],
      workingDir: '/',
    });
    const s = spec('oaxrt.CCCCCCCC.sig', {
      limits: { cpus: 0.5, memoryMb: 128, timeoutSeconds: 1, pids: 64 },
    });
    const handle = await slow.startNode(s);
    expect(await handle.wait()).toEqual({ exitCode: null, reason: 'timeout' });
    expect(() => docker('inspect', `oax-node-${s.nodeId}`)).toThrow();
  });

  it('refuses a network that is not internal', async () => {
    docker('network', 'create', `${NETWORK}-open`);
    try {
      const open = new ContainerRunner({
        engineUrl: process.env.OAX_TEST_ENGINE_URL ?? 'unix:///var/run/docker.sock',
        allowRawSocket: process.env.OAX_TEST_ALLOW_RAW_SOCKET === '1',
        image: IMAGE,
        network: `${NETWORK}-open`,
      });
      await expect(open.startNode(spec('oaxrt.DDDDDDDD.sig'))).rejects.toMatchObject({
        code: 'network_not_internal',
      });
    } finally {
      docker('network', 'rm', `${NETWORK}-open`);
    }
  });
});

describe('opt-in marker', () => {
  it(`is ${enabled ? 'enabled' : 'skipped (set OAX_TEST_DOCKER=1 and OAX_TEST_IMAGE)'}`, () => {
    expect(typeof enabled).toBe('boolean');
  });
});

import { HARNESS_KINDS, OaxError, type HarnessKind, type RunnerKind } from '@openagentix/core';
import { z } from 'zod';
import type { EngineHijack } from './container-hijack.js';
import { mintEgressGrant } from './egress-proxy.js';
import { nodeTraceparent } from './node-env.js';
import { assertWithinCeiling, parseEgressEntry } from './egress-rules.js';
import {
  EngineClient,
  isRawDockerSocket,
  nodeHijack,
  nodeTransport,
  parseEngineUrl,
  type EngineEndpoint,
  type EngineTransport,
  type StdinHandle,
} from './container-engine.js';
import type {
  IsolatingRunner,
  PreparedRun,
  RunNodeExit,
  RunNodeHandle,
  RunNodeSpec,
  RunNodeStopReason,
  RunResult,
  RunnerContext,
} from './types.js';

/**
 * The `container` runner (ADR 0005, ADR 0008 section 3.5): one short-lived, hardened container per
 * isolated step. It never receives secret values: the node gets a step-scoped run token as a file
 * on a tmpfs and fetches its credentials itself from the control node's broker.
 */

/** `name@sha256:<64 hex>`; a tag alone can be moved, so tags are never accepted. */
export const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/;

/** Upper bound for MiB values (1 TiB): anything larger is a typo, not a limit. */
const MAX_MIB = 1_048_576;

export const ContainerRunnerConfigSchema = z
  .strictObject({
    engine: z.enum(['docker', 'podman']).default('docker'),
    /**
     * `unix:///run/user/1000/podman/podman.sock` (rootless Podman) or `http://socket-proxy:2375`
     * (a Docker socket proxy). There is deliberately no default: the Docker daemon's own socket is
     * refused unless `allowRawSocket` is set.
     */
    engineUrl: z.string().min(1),
    allowRawSocket: z.boolean().default(false),
    /** Default run node image, pinned by digest. */
    image: z.string().regex(IMAGE_DIGEST, 'image must be pinned by digest (name@sha256:...)'),
    /** Toolbox name (`git+node`) -> image pinned by digest. Unknown toolboxes are refused. */
    toolboxImages: z
      .record(z.string(), z.string().regex(IMAGE_DIGEST, 'image must be pinned by digest'))
      .default({}),
    /**
     * Harness (`claude-code`, ...) -> image pinned by digest (DOG-1). A step with `runtime.harness`
     * runs ONLY on the image of its harness; an unknown harness fails closed (`harness_image_unknown`).
     * The keys are the allowlist: only kinds of `HARNESS_KINDS` are accepted.
     */
    harnessImages: z
      .partialRecord(
        z.enum(HARNESS_KINDS),
        z.string().regex(IMAGE_DIGEST, 'image must be pinned by digest'),
      )
      .default({}),
    /** Memory (MiB) of a harness step's node; clamped to `maxMemoryMb`. Claude Code needs about 1 GiB. */
    harnessMemoryMb: z.number().int().min(256).max(MAX_MIB).default(2048),
    /**
     * `/tmp` tmpfs (MiB) of a harness step's node: the repository checkout and test scratch space.
     * tmpfs pages count against the container memory, so it may be at most half of it.
     */
    harnessTmpMb: z.number().int().positive().max(MAX_MIB).default(256),
    /**
     * A harness step normally reaches only the control node. Declared egress hosts are refused for it
     * unless the operator opts in (`OAX_HARNESS_EGRESS_ALLOWED`).
     */
    harnessEgressAllowed: z.boolean().default(false),
    /** Pre-created network with `internal: true`; its only neighbours are the control node and the proxy. */
    network: z.string().min(1),
    /**
     * URL nodes use for the egress proxy (a separate service, reachable from the internal network).
     * Without it no step can declare egress.
     */
    egressProxyUrl: z.string().url().optional(),
    /** HMAC key shared with the egress proxy; signs each node's grant. Required with the URL. */
    egressGrantSecret: z.string().min(32).optional(),
    /** Operator upper bound for step egress (same grammar as `runtime.egress`); empty = none. */
    egressAllow: z.array(z.string()).default([]),
    command: z.array(z.string().min(1)).min(1).default(['node', 'dist/run-node-cli.js']),
    workingDir: z.string().default('/app/apps/worker'),
    /** Upper bounds; a step's limits are clamped to them. */
    maxCpus: z.number().positive().default(1),
    maxMemoryMb: z.number().int().min(64).max(MAX_MIB).default(512),
    /**
     * Default memory (MiB) of an ordinary node. Distinct from the ceiling `maxMemoryMb`: raising the
     * ceiling for harness steps must not give every ordinary node more memory. Clamped to the ceiling.
     */
    memoryMb: z.number().int().min(64).max(MAX_MIB).default(512),
    maxPids: z.number().int().positive().default(256),
    /** Identifies this installation on a shared engine; set a distinct value per installation. */
    instanceId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .default('default'),
    /** Numeric non-root user and group of the node process. */
    uid: z.number().int().min(1000).max(65534).default(10001),
    /** `/tmp` tmpfs (MiB) of an ordinary node; harness steps use `harnessTmpMb`. */
    tmpMb: z.number().int().positive().max(MAX_MIB).default(64),
    stopGraceSeconds: z.number().int().nonnegative().default(5),
  })
  .superRefine((c, ctx) => {
    // tmpfs pages count against the container's memory: a /tmp that cannot fit would only fail late
    // (OOM kill while writing). Require a sane margin: at most half of the memory.
    const checks: [string, string, number, number][] = [
      ['tmpMb', 'OAX_CONTAINER_TMP_MB', c.tmpMb, Math.min(c.memoryMb, c.maxMemoryMb)],
      ...(Object.keys(c.harnessImages).length > 0
        ? ([
            [
              'harnessTmpMb',
              'OAX_CONTAINER_HARNESS_TMP_MB',
              c.harnessTmpMb,
              Math.min(c.harnessMemoryMb, c.maxMemoryMb),
            ],
          ] as [string, string, number, number][])
        : []),
    ];
    for (const [field, env, tmp, memory] of checks)
      if (tmp * 2 > memory)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${env} (${tmp}) must be at most half of the node memory (${memory} MiB, see OAX_CONTAINER_MEMORY_MB / OAX_CONTAINER_HARNESS_MEMORY_MB / OAX_CONTAINER_MAX_MEMORY_MB)`,
        });
  });
export type ContainerRunnerConfig = z.infer<typeof ContainerRunnerConfigSchema>;
export type ContainerRunnerConfigInput = z.input<typeof ContainerRunnerConfigSchema>;

export const NODE_LABEL = 'io.openagentix.run-node';
/** Installation id: the reaper only ever touches containers of its own installation. */
export const INSTANCE_LABEL = 'io.openagentix.instance';
/** Unix seconds after which the container must not exist any more (hard lifetime). */
export const EXPIRES_LABEL = 'io.openagentix.expires';
const TOKEN_DIR = '/run/oax';
/** The token arrives on stdin: not env, not a command line, not copyable, not in `inspect`. */
const TOKEN_STDIN = '/dev/stdin';
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

/** What the engine receives; kept as plain data so it can be asserted in tests. */
export interface CreateBody {
  Image: string;
  Cmd: string[];
  WorkingDir: string;
  User: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown>;
  NetworkingConfig: { EndpointsConfig: Record<string, Record<string, never>> };
  [k: string]: unknown;
}

/**
 * Defence in depth: refuses any create options that would weaken the isolation, no matter how they
 * got there. The runner builds its own options and runs this check on them before every create, so
 * a future change that adds a bind mount or a capability fails loudly instead of silently.
 */
export function assertSafeCreateBody(body: Record<string, unknown>): void {
  const problems: string[] = [];
  const h = (body.HostConfig ?? {}) as Record<string, unknown>;
  const nonEmpty = (v: unknown) =>
    Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '' && v !== false;
  if (h.Privileged === true) problems.push('privileged');
  for (const k of [
    'Binds',
    'Devices',
    'DeviceRequests',
    'CapAdd',
    'VolumesFrom',
    'Links',
    'Sysctls',
    'Runtime',
    'GroupAdd',
    'ExtraHosts',
    'CgroupParent',
  ])
    if (nonEmpty(h[k])) problems.push(`HostConfig.${k}`);
  if (nonEmpty(body.Volumes)) problems.push('Volumes');
  for (const m of (h.Mounts as { Type?: string }[] | undefined) ?? [])
    if (m.Type !== 'tmpfs') problems.push(`mount of type ${String(m.Type)}`);
  const shared = (v: unknown) => typeof v === 'string' && v !== '' && v !== 'private';
  for (const k of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'])
    if (shared(h[k])) problems.push(`HostConfig.${k}`);
  const net = String(h.NetworkMode ?? '');
  if (
    net === '' ||
    net === 'host' ||
    net === 'default' ||
    net === 'bridge' ||
    net.startsWith('container:')
  )
    problems.push(`network mode "${net}"`);
  if (h.ReadonlyRootfs !== true) problems.push('rootfs is not read-only');
  const drop = (h.CapDrop as string[] | undefined) ?? [];
  if (!drop.map((c) => c.toUpperCase()).includes('ALL'))
    problems.push('capabilities are not dropped');
  const sec = (h.SecurityOpt as string[] | undefined) ?? [];
  if (!sec.includes('no-new-privileges:true')) problems.push('no-new-privileges is missing');
  if (sec.some((s) => /unconfined|systempaths/i.test(s)))
    problems.push('SecurityOpt weakens isolation');
  if (!((h.Memory as number) > 0)) problems.push('no memory limit');
  if (!((h.NanoCpus as number) > 0)) problems.push('no CPU limit');
  if (!((h.PidsLimit as number) > 0)) problems.push('no PID limit');
  const user = String(body.User ?? '');
  if (!/^[1-9]\d*(:[1-9]\d*)?$/.test(user)) problems.push('user is not a numeric non-root id');
  if (!IMAGE_DIGEST.test(String(body.Image ?? ''))) problems.push('image is not pinned by digest');
  for (const e of (body.Env as string[] | undefined) ?? []) {
    if (/(^|=)oaxrt\./.test(e) || /^(OAX_RUN_TOKEN=|OAX_SECRET_)/.test(e))
      problems.push('a token or secret is in the environment');
  }
  if (problems.length)
    throw new OaxError(
      'container_options_refused',
      `refusing to start a container with unsafe options: ${problems.join(', ')}`,
      problems,
    );
}

export interface ContainerRunnerDeps {
  /** Injectable transport (tests, custom TLS); defaults to node's http client. */
  transport?: EngineTransport;
  /** Injectable attach (hijack) function; defaults to node's http client. */
  hijack?: EngineHijack;
}

export class ContainerRunner implements IsolatingRunner {
  readonly kind: RunnerKind = 'container';
  readonly config: ContainerRunnerConfig;
  /** `true` when the raw Docker socket was explicitly allowed (the caller audits and warns). */
  readonly unsafeSocket: boolean;
  private readonly engine: EngineClient;
  private readonly endpoint: EngineEndpoint;
  private readonly egressCeiling: ReturnType<typeof parseEgressEntry>[];

  constructor(config: ContainerRunnerConfigInput, deps: ContainerRunnerDeps = {}) {
    this.config = ContainerRunnerConfigSchema.parse(config);
    this.endpoint = parseEngineUrl(this.config.engineUrl);
    this.unsafeSocket = isRawDockerSocket(this.endpoint);
    if (this.unsafeSocket && !this.config.allowRawSocket) {
      throw new OaxError(
        'config_invalid',
        'the container runner refuses the raw Docker socket; use a socket proxy, rootless Podman, or set OAX_CONTAINER_ALLOW_RAW_SOCKET=true (unsafe)',
      );
    }
    this.engine = new EngineClient(
      deps.transport ?? nodeTransport(this.endpoint),
      deps.hijack ?? nodeHijack(this.endpoint),
    );
    if (!!this.config.egressProxyUrl !== !!this.config.egressGrantSecret)
      throw new OaxError(
        'config_invalid',
        'egressProxyUrl and egressGrantSecret must be set together (or neither: no step egress)',
      );
    this.egressCeiling = this.config.egressAllow.map(parseEgressEntry);
  }

  /**
   * Removes run node containers that outlived their hard lifetime (a crashed worker, a lost
   * engine connection). Safe to call at startup and periodically: live nodes carry a future
   * expiry and are never touched. Returns the number of removed containers.
   */
  async reapOrphans(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const c of await this.engine.listContainers([
      `${NODE_LABEL}=true`,
      `${INSTANCE_LABEL}=${this.config.instanceId}`,
    ])) {
      // Defence in depth on top of the engine-side filter: both labels must really be there.
      if (
        c.Labels?.[NODE_LABEL] !== 'true' ||
        c.Labels?.[INSTANCE_LABEL] !== this.config.instanceId
      )
        continue;
      const raw = c.Labels[EXPIRES_LABEL] ?? '';
      const expires = /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
      // An unparsable or missing expiry is not "expired": leave the container alone.
      if (!Number.isFinite(expires) || expires * 1000 > now) continue;
      await this.engine.removeContainer(c.Id).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  /** The orchestrator starts nodes per step through {@link startNode}; there is no whole-run mode. */
  async execute(_run: PreparedRun, _ctx: RunnerContext): Promise<RunResult> {
    throw new OaxError(
      'runner_not_whole_run',
      'the container runner executes single steps as run nodes; set it as `runtime.runner` and let the worker orchestrate the run',
    );
  }

  /**
   * Limits the worker hands to ordinary steps: the default memory (never the ceiling), clamped to
   * the ceiling. CPU and pids use their maximum as before.
   */
  defaultLimits(): { cpus: number; memoryMb: number; pids: number } {
    const c = this.config;
    return { cpus: c.maxCpus, memoryMb: Math.min(c.memoryMb, c.maxMemoryMb), pids: c.maxPids };
  }

  /** Images a node may run: the default image and the configured toolbox images. */
  allowedImages(): Set<string> {
    return new Set([
      this.config.image,
      ...Object.values(this.config.toolboxImages),
      ...Object.values(this.config.harnessImages),
    ]);
  }

  /** Image for a step: its toolbox's image, else the default. Unknown toolboxes fail closed. */
  imageFor(toolbox: string | undefined, harness?: HarnessKind): string {
    // A harness step runs on the image of its harness (it contains the pinned binary); the toolbox
    // cannot be combined with it, so the allowlist stays one-to-one.
    if (harness) {
      const image = this.config.harnessImages[harness];
      if (!image)
        throw new OaxError(
          'harness_image_unknown',
          `no image is configured for harness "${harness}" (OAX_CONTAINER_HARNESS_IMAGES)`,
        );
      return image;
    }
    if (!toolbox) return this.config.image;
    const image = this.config.toolboxImages[toolbox];
    if (!image)
      throw new OaxError(
        'toolbox_image_unknown',
        `no image is configured for toolbox "${toolbox}" (OAX_CONTAINER_TOOLBOX_IMAGES)`,
      );
    return image;
  }

  private validate(spec: RunNodeSpec): void {
    const c = this.config;
    if (!ID.test(spec.nodeId) || !ID.test(spec.runId))
      throw new OaxError('run_node_invalid', 'run or node id has an invalid format');
    if (spec.steps.length < 1 || spec.steps.length > 16 || !spec.steps.every((s) => SLUG.test(s)))
      throw new OaxError('run_node_invalid', 'a run node needs 1-16 valid step ids');
    if (!spec.runToken.startsWith('oaxrt.'))
      throw new OaxError('run_node_invalid', 'the run token is not a run token');
    if (!this.allowedImages().has(spec.image))
      throw new OaxError(
        'image_not_allowed',
        'image is not the configured run node image or a configured toolbox image',
      );
    try {
      const u = new URL(spec.controlUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    } catch {
      throw new OaxError('run_node_invalid', 'control URL is not an http(s) URL');
    }
    // The harness image carries a proprietary binary and the harness's runtime settings: an ordinary
    // step may only receive it when it is also the default or a toolbox image (operator's choice).
    const harnessImages = Object.values(c.harnessImages);
    if (
      !spec.harness &&
      harnessImages.includes(spec.image) &&
      spec.image !== c.image &&
      !Object.values(c.toolboxImages).includes(spec.image)
    )
      throw new OaxError(
        'image_not_allowed',
        'a step without a harness must not run on a harness image',
      );
    if (spec.harness) {
      if (spec.image !== c.harnessImages[spec.harness])
        throw new OaxError(
          'image_not_allowed',
          `a "${spec.harness}" harness step must run on the image configured for that harness`,
        );
      // "Control node only" is enforced here too, not only at publish: the node network is internal
      // and no egress grant is minted, unless the operator explicitly allows harness egress.
      if (spec.egress.length > 0 && !c.harnessEgressAllowed)
        throw new OaxError(
          'harness_egress_denied',
          'a harness step must not declare egress (OAX_HARNESS_EGRESS_ALLOWED is not set); it reaches the control node only',
        );
    }
    if (spec.egress.length > 0) {
      if (!c.egressProxyUrl || !c.egressGrantSecret)
        throw new OaxError(
          'egress_proxy_missing',
          'the step declares egress hosts but no egress proxy is configured; refusing to start (deny by default)',
        );
      // Syntax, minimum prefixes and the operator ceiling (intersection, never a union).
      assertWithinCeiling(spec.egress, this.egressCeiling);
    }
    const l = spec.limits;
    if (!(l.cpus > 0 && l.memoryMb >= 64 && l.pids > 0 && l.timeoutSeconds > 0))
      throw new OaxError('run_node_invalid', 'run node limits must be positive');
  }

  /** The options of the container; exposed for tests and `assertSafeCreateBody`. */
  buildCreateBody(spec: RunNodeSpec): CreateBody {
    const c = this.config;
    // Harness steps get their own memory and /tmp sizes (Claude Code plus a repository checkout);
    // the operator maximum still caps the memory.
    const memoryMb = spec.harness
      ? Math.min(c.harnessMemoryMb, c.maxMemoryMb)
      : Math.min(spec.limits.memoryMb, c.maxMemoryMb);
    const tmpMb = spec.harness ? c.harnessTmpMb : c.tmpMb;
    const memory = memoryMb * 1024 * 1024;
    const tmpfs = (mb: number, mode: string) =>
      `rw,noexec,nosuid,nodev,size=${mb}m,mode=${mode},uid=${c.uid},gid=${c.uid}`;
    return {
      Image: spec.image,
      Cmd: [...c.command],
      WorkingDir: c.workingDir,
      User: `${c.uid}:${c.uid}`,
      // Non-secret facts only: ids, the control URL and file locations. Never the token itself.
      Env: [
        `OAX_CONTROL_URL=${spec.controlUrl}`,
        `OAX_RUN_ID=${spec.runId}`,
        `OAX_NODE_ID=${spec.nodeId}`,
        `OAX_STEP_IDS=${spec.steps.join(',')}`,
        `OAX_RUN_TOKEN_FILE=${TOKEN_STDIN}`,
        // The node exits by itself at its deadline; the reaper removes what outlives it anyway.
        `OAX_NODE_DEADLINE_SECONDS=${Math.ceil(spec.limits.timeoutSeconds) + 30}`,
        'NODE_ENV=production',
        'HOME=/tmp',
        ...(nodeTraceparent(spec.traceparent)
          ? [`TRACEPARENT=${nodeTraceparent(spec.traceparent)}`]
          : []),
      ],
      Labels: {
        [NODE_LABEL]: 'true',
        [INSTANCE_LABEL]: this.config.instanceId,
        [EXPIRES_LABEL]: String(
          Math.floor(Date.now() / 1000) + Math.ceil(spec.limits.timeoutSeconds) + 90,
        ),
        'io.openagentix.run-id': spec.runId,
        'io.openagentix.node-id': spec.nodeId,
      },
      // stdin carries the step-scoped run token (and the proxy account) once, then reaches EOF.
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      HostConfig: {
        NetworkMode: c.network,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: Math.round(Math.min(spec.limits.cpus, c.maxCpus) * 1e9),
        PidsLimit: Math.min(spec.limits.pids, c.maxPids),
        Tmpfs: { '/tmp': tmpfs(tmpMb, '1777'), [TOKEN_DIR]: tmpfs(1, '0700') },
        Init: true,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
        IpcMode: 'private',
      },
      NetworkingConfig: { EndpointsConfig: { [c.network]: {} } },
    };
  }

  async startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal } = {}): Promise<RunNodeHandle> {
    this.validate(spec);
    ctx.signal?.throwIfAborted();
    // The network must exist and be internal: anything else would give the node a route out.
    const net = await this.engine.inspectNetwork(this.config.network);
    if (net.Internal !== true)
      throw new OaxError(
        'network_not_internal',
        `network "${this.config.network}" is not an internal network; refusing to start a run node`,
      );
    const body = this.buildCreateBody(spec);
    assertSafeCreateBody(body);
    // A signed, expiring grant: the stateless proxy verifies it, nothing to unregister afterwards.
    const proxyPassword =
      spec.egress.length > 0 && this.config.egressProxyUrl && this.config.egressGrantSecret
        ? mintEgressGrant(this.config.egressGrantSecret, {
            nodeId: spec.nodeId,
            egress: spec.egress,
            ttlSeconds: Math.ceil(spec.limits.timeoutSeconds) + 60,
          })
        : undefined;
    let id: string | undefined;
    const cleanup = async () => {
      if (id) await this.engine.removeContainer(id).catch(() => undefined);
    };
    let stdin: StdinHandle | undefined;
    try {
      id = await this.engine.createContainer(`oax-node-${spec.nodeId}`, body);
      // Attach before the start so that the node can never miss its token.
      stdin = await this.engine.attachStdin(id, ctx.signal);
      await this.engine.startContainer(id);
      // Line 1: the run token. Line 2 (only with egress): the node's account at the egress proxy.
      const lines = [
        spec.runToken,
        ...(proxyPassword
          ? [proxyUrlWithCredentials(this.config.egressProxyUrl!, spec.nodeId, proxyPassword)]
          : []),
      ];
      await stdin.send(Buffer.from(`${lines.join('\n')}\n`));
    } catch (e) {
      stdin?.abort();
      await cleanup();
      throw e;
    }
    return this.handle(id, spec, cleanup);
  }

  private handle(id: string, spec: RunNodeSpec, cleanup: () => Promise<void>): RunNodeHandle {
    let stopping: Promise<void> | null = null;
    const stop = (_reason: RunNodeStopReason): Promise<void> => {
      stopping ??= (async () => {
        try {
          await this.engine.stopContainer(id, this.config.stopGraceSeconds).catch(() => undefined);
          await this.engine.killContainer(id).catch(() => undefined);
        } finally {
          await cleanup();
        }
      })();
      return stopping;
    };
    const wait = async (signal?: AbortSignal): Promise<RunNodeExit> => {
      const ac = new AbortController();
      let reason: string | undefined;
      const end = (r: string) => {
        reason ??= r;
        ac.abort();
      };
      const timer = setTimeout(() => end('timeout'), spec.limits.timeoutSeconds * 1000);
      const onAbort = () => end('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        return { exitCode: await this.engine.waitContainer(id, ac.signal) };
      } catch (e) {
        if (reason) {
          await stop(reason === 'timeout' ? 'timeout' : 'cancelled');
          return { exitCode: null, reason };
        }
        throw e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };
    return { nodeId: spec.nodeId, wait, stop };
  }
}

export function proxyUrlWithCredentials(base: string, nodeId: string, password: string): string {
  const u = new URL(base);
  u.username = encodeURIComponent(nodeId);
  u.password = encodeURIComponent(password);
  return u.toString();
}

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { OaxError } from '@openagentix/core';

/** A Kubernetes object as far as this package needs to look at it. */
export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: OwnerReference[];
  };
  [key: string]: unknown;
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface JobStatus {
  uid: string;
  succeeded: number;
  failed: number;
  active: number;
  /** Terminal condition, when the Job controller has set one. */
  condition?: { type: 'Complete' | 'Failed'; reason?: string; message?: string };
}

/**
 * The only Kubernetes API surface the runner uses. Every method maps to one RBAC rule, see
 * {@link REQUIRED_RBAC}; there is deliberately no pod access, no list and no watch.
 */
export interface KubeClient {
  createJob(namespace: string, job: KubeObject): Promise<{ uid: string }>;
  /** JSON merge patch (`application/merge-patch+json`). */
  patchJob(namespace: string, name: string, patch: Record<string, unknown>): Promise<void>;
  getJob(namespace: string, name: string): Promise<JobStatus | null>;
  /**
   * Idempotent: a missing Job is not an error. Uses Foreground propagation, so the Job object
   * only disappears after its Pods are gone. With `uid` the delete carries a uid precondition and
   * never touches another object that happens to have the same name.
   */
  deleteJob(namespace: string, name: string, uid?: string): Promise<void>;
  createSecret(namespace: string, secret: KubeObject): Promise<{ uid: string }>;
  deleteSecret(namespace: string, name: string, uid?: string): Promise<void>;
  createNetworkPolicy(namespace: string, policy: KubeObject): Promise<{ uid: string }>;
  /** Reads one NetworkPolicy (only the namespace default-deny policy is ever read). */
  getNetworkPolicy(namespace: string, name: string): Promise<KubeObject | null>;
  deleteNetworkPolicy(namespace: string, name: string, uid?: string): Promise<void>;
}

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  /** Restricts the rule to these object names. */
  resourceNames?: string[];
}

/** Namespaced Role rules for the run namespace; mirrored by docs/examples/kubernetes-job-runner-rbac.yaml. */
export const REQUIRED_RBAC: readonly RbacRule[] = [
  { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'patch', 'delete'] },
  { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'delete'] },
  { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['create', 'delete'] },
  // Read access to exactly the namespace default-deny policy (checked before every start).
  {
    apiGroups: ['networking.k8s.io'],
    resources: ['networkpolicies'],
    resourceNames: ['default-deny-all'],
    verbs: ['get'],
  },
];

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type KubeTransport = (req: {
  method: string;
  path: string;
  contentType?: string;
  body?: unknown;
}) => Promise<HttpResponse>;

export interface InClusterOptions {
  /** e.g. `https://10.0.0.1:443`. */
  apiServer: string;
  /** Bearer token or a function returning it (projected tokens rotate). */
  token: string | (() => string);
  /** PEM CA bundle of the API server. */
  ca?: string;
  /** Plain http would send the bearer token in clear text; only for local tests/`kubectl proxy`. */
  allowInsecure?: boolean;
  /** Test seam; defaults to node:http(s). */
  transport?: KubeTransport;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function uidOf(res: HttpResponse): string {
  const uid = (res.body as { metadata?: { uid?: string } } | null)?.metadata?.uid;
  if (!uid)
    throw new OaxError('kubernetes_api_error', 'Kubernetes API returned an object without uid');
  return uid;
}

function failure(op: string, res: HttpResponse): OaxError {
  const msg =
    typeof res.body === 'object' && res.body !== null && 'message' in res.body
      ? String((res.body as { message: unknown }).message)
      : '';
  return new OaxError(
    'kubernetes_api_error',
    `Kubernetes API ${op} failed with HTTP ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ''}`,
  );
}

/** Minimal Kubernetes API client using the pod's own ServiceAccount (in-cluster config). */
export class InClusterKubeClient implements KubeClient {
  private readonly transport: KubeTransport;
  private readonly token: () => string;

  constructor(opts: InClusterOptions) {
    if (!opts.transport && !opts.allowInsecure && !opts.apiServer.startsWith('https://')) {
      throw new OaxError('config_invalid', 'the Kubernetes API server URL must use https');
    }
    this.token = typeof opts.token === 'function' ? opts.token : () => opts.token as string;
    this.transport = opts.transport ?? defaultTransport(opts.apiServer, this.token, opts.ca);
  }

  /** Builds a client from the standard in-cluster environment and projected token. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): InClusterKubeClient {
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) {
      throw new OaxError(
        'config_invalid',
        'not running in a cluster: KUBERNETES_SERVICE_HOST is not set',
      );
    }
    const hostPart = host.includes(':') ? `[${host}]` : host;
    return new InClusterKubeClient({
      apiServer: `https://${hostPart}:${port}`,
      token: () => readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
      ca: readFileSync(`${SA_DIR}/ca.crt`, 'utf8'),
    });
  }

  private ns(namespace: string): string {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) {
      throw new OaxError('config_invalid', `invalid Kubernetes namespace "${namespace}"`);
    }
    return namespace;
  }

  async createJob(namespace: string, job: KubeObject): Promise<{ uid: string }> {
    const res = await this.transport({
      method: 'POST',
      path: `/apis/batch/v1/namespaces/${this.ns(namespace)}/jobs`,
      body: job,
    });
    if (res.status !== 201 && res.status !== 200) throw failure('create Job', res);
    const uid = (res.body as { metadata?: { uid?: string } } | null)?.metadata?.uid;
    if (!uid)
      throw new OaxError('kubernetes_api_error', 'Kubernetes API returned a Job without uid');
    return { uid };
  }

  async patchJob(namespace: string, name: string, patch: Record<string, unknown>): Promise<void> {
    const res = await this.transport({
      method: 'PATCH',
      path: `/apis/batch/v1/namespaces/${this.ns(namespace)}/jobs/${encodeURIComponent(name)}`,
      contentType: 'application/merge-patch+json',
      body: patch,
    });
    if (res.status !== 200) throw failure('patch Job', res);
  }

  async getJob(namespace: string, name: string): Promise<JobStatus | null> {
    const res = await this.transport({
      method: 'GET',
      path: `/apis/batch/v1/namespaces/${this.ns(namespace)}/jobs/${encodeURIComponent(name)}`,
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw failure('get Job', res);
    const j = res.body as {
      metadata?: { uid?: string };
      status?: {
        succeeded?: number;
        failed?: number;
        active?: number;
        conditions?: { type: string; status: string; reason?: string; message?: string }[];
      };
    };
    const terminal = j.status?.conditions?.find(
      (c) => c.status === 'True' && (c.type === 'Complete' || c.type === 'Failed'),
    );
    return {
      uid: j.metadata?.uid ?? '',
      succeeded: j.status?.succeeded ?? 0,
      failed: j.status?.failed ?? 0,
      active: j.status?.active ?? 0,
      ...(terminal
        ? {
            condition: {
              type: terminal.type as 'Complete' | 'Failed',
              ...(terminal.reason ? { reason: terminal.reason } : {}),
              ...(terminal.message ? { message: terminal.message } : {}),
            },
          }
        : {}),
    };
  }

  async deleteJob(namespace: string, name: string, uid?: string): Promise<void> {
    await this.remove(
      `/apis/batch/v1/namespaces/${this.ns(namespace)}/jobs/${encodeURIComponent(name)}`,
      'delete Job',
      { propagationPolicy: 'Foreground', ...(uid ? { preconditions: { uid } } : {}) },
    );
  }

  async createSecret(namespace: string, secret: KubeObject): Promise<{ uid: string }> {
    const res = await this.transport({
      method: 'POST',
      path: `/api/v1/namespaces/${this.ns(namespace)}/secrets`,
      body: secret,
    });
    if (res.status !== 201 && res.status !== 200) throw failure('create Secret', res);
    return { uid: uidOf(res) };
  }

  async deleteSecret(namespace: string, name: string, uid?: string): Promise<void> {
    await this.remove(
      `/api/v1/namespaces/${this.ns(namespace)}/secrets/${encodeURIComponent(name)}`,
      'delete Secret',
      uid ? { preconditions: { uid } } : undefined,
    );
  }

  async createNetworkPolicy(namespace: string, policy: KubeObject): Promise<{ uid: string }> {
    const res = await this.transport({
      method: 'POST',
      path: `/apis/networking.k8s.io/v1/namespaces/${this.ns(namespace)}/networkpolicies`,
      body: policy,
    });
    if (res.status !== 201 && res.status !== 200) throw failure('create NetworkPolicy', res);
    return { uid: uidOf(res) };
  }

  async getNetworkPolicy(namespace: string, name: string): Promise<KubeObject | null> {
    const res = await this.transport({
      method: 'GET',
      path: `/apis/networking.k8s.io/v1/namespaces/${this.ns(namespace)}/networkpolicies/${encodeURIComponent(name)}`,
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw failure('get NetworkPolicy', res);
    return res.body as KubeObject;
  }

  async deleteNetworkPolicy(namespace: string, name: string, uid?: string): Promise<void> {
    await this.remove(
      `/apis/networking.k8s.io/v1/namespaces/${this.ns(namespace)}/networkpolicies/${encodeURIComponent(name)}`,
      'delete NetworkPolicy',
      uid ? { preconditions: { uid } } : undefined,
    );
  }

  private async remove(path: string, op: string, body?: unknown): Promise<void> {
    const res = await this.transport({ method: 'DELETE', path, ...(body ? { body } : {}) });
    // 404: already gone. 409: the uid precondition failed, i.e. the object is not ours any more.
    if (res.status === 404 || (res.status === 409 && body)) return;
    if (res.status < 200 || res.status >= 300) throw failure(op, res);
  }
}

function defaultTransport(apiServer: string, token: () => string, ca?: string): KubeTransport {
  const base = new URL(apiServer);
  const lib = base.protocol === 'https:' ? https : http;
  return (req) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
      const r = lib.request(
        {
          protocol: base.protocol,
          hostname: base.hostname.replace(/^\[|\]$/g, ''),
          port: base.port || (base.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: req.path,
          ...(ca ? { ca } : {}),
          timeout: 30_000,
          headers: {
            authorization: `Bearer ${token()}`,
            accept: 'application/json',
            ...(payload !== undefined
              ? {
                  'content-type': req.contentType ?? 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = { message: text.slice(0, 200) };
              }
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('Kubernetes API request timed out')));
      r.on('error', reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    });
}

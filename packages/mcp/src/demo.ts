import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMockMcpServer } from './testing.js';

/**
 * Deterministic demo MCP servers used by `examples/*.agents.md`, the local CLI and the public demo.
 * No network access; state lives in memory per process.
 */

const CVES: Record<
  string,
  { severity: string; cvss: number; summary: string; fixedIn: string | null }
> = {
  'CVE-2024-3094': {
    severity: 'CRITICAL',
    cvss: 10,
    summary: 'Backdoor in xz/liblzma 5.6.0-5.6.1',
    fixedIn: '5.6.2',
  },
  'CVE-2023-44487': {
    severity: 'HIGH',
    cvss: 7.5,
    summary: 'HTTP/2 rapid reset denial of service',
    fixedIn: 'vendor specific',
  },
  'CVE-2021-44228': {
    severity: 'CRITICAL',
    cvss: 10,
    summary: 'Log4Shell remote code execution in log4j-core',
    fixedIn: '2.17.1',
  },
  'CVE-2022-0778': {
    severity: 'HIGH',
    cvss: 7.5,
    summary: 'OpenSSL infinite loop in BN_mod_sqrt()',
    fixedIn: '3.0.2',
  },
};

export function cveDbServer(): Server {
  return createMockMcpServer('cve-db', [
    {
      name: 'lookup_cve',
      description:
        'Look up a CVE by id and return severity, CVSS score, summary and fixed version.',
      inputSchema: {
        type: 'object',
        properties: { cveId: { type: 'string' } },
        required: ['cveId'],
      },
      handler: (args) => {
        const id = String(args.cveId ?? '');
        const hit = CVES[id];
        if (!hit) throw new Error(`unknown CVE ${id}`);
        return { cveId: id, ...hit };
      },
    },
  ]);
}

export interface Ticket {
  key: string;
  status: string;
  labels: string[];
  comments: string[];
}

export function ticketsServer(store: Map<string, Ticket> = new Map()): Server {
  const get = (key: string): Ticket => {
    let t = store.get(key);
    if (!t) {
      t = { key, status: 'open', labels: [], comments: [] };
      store.set(key, t);
    }
    return t;
  };
  return createMockMcpServer('tickets', [
    {
      name: 'get_ticket',
      description: 'Read a ticket.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      handler: (args) => get(String(args.key)),
    },
    {
      name: 'add_comment',
      description: 'Add a comment to a ticket.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, comment: { type: 'string' } },
        required: ['key', 'comment'],
      },
      handler: (args) => {
        const t = get(String(args.key));
        t.comments.push(String(args.comment));
        return { ok: true, key: t.key, comments: t.comments.length };
      },
    },
    {
      name: 'update_ticket',
      description: 'Change status and labels of a ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          status: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['key'],
      },
      handler: (args) => {
        const t = get(String(args.key));
        if (typeof args.status === 'string') t.status = args.status;
        if (Array.isArray(args.labels)) t.labels = args.labels.map(String);
        return { ok: true, ticket: t };
      },
    },
    {
      name: 'delete_ticket',
      description: 'Delete a ticket (dangerous; forbidden by the default policy).',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      handler: (args) => ({ deleted: store.delete(String(args.key)) }),
    },
  ]);
}

/** Factories for every demo server, keyed by connection name. */
export function demoServerFactories(
  ticketStore?: Map<string, Ticket>,
): Record<string, () => Server> {
  return { 'cve-db': cveDbServer, tickets: () => ticketsServer(ticketStore) };
}

/** Access classes of the built-in demo servers, so read-only steps can use their read tools. */
export const DEMO_TOOL_ACCESS: Readonly<
  Record<string, Record<string, { access: 'read' | 'write' }>>
> = {
  'cve-db': { lookup_cve: { access: 'read' } },
  tickets: {
    get_ticket: { access: 'read' },
    add_comment: { access: 'write' },
    update_ticket: { access: 'write' },
    delete_ticket: { access: 'write' },
  },
};

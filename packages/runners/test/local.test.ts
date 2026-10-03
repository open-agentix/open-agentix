import { describe, expect, it } from 'vitest';
import { LocalRunner, runLocal, toEvent } from '../src/index.js';
import { example } from './helpers.js';

describe('runLocal', () => {
  it('runs an example with demo MCP servers and verifies the audit chain', async () => {
    const steps: string[] = [];
    const report = await runLocal({
      agentsSource: example('cve-triage.agents.md'),
      event: JSON.parse(example('events/trivy-finding.json')),
      onStep: (s) => steps.push(s.kind),
    });
    expect(report.result.status).toBe('succeeded');
    expect(report.audit.valid).toBe(true);
    expect(steps.at(-1)).toBe('output');
    expect(new LocalRunner().kind).toBe('local');
  });
  it('honours approval and explicit config', async () => {
    const report = await runLocal({
      agentsSource: example('ticket-updater.agents.md'),
      event: JSON.parse(example('events/jira-issue.json')),
      approve: 'all',
      providers: [{ kind: 'simulated', name: 'simulated' }],
      mcpServers: [{ name: 'tickets', transport: 'in-memory' }],
      prices: [],
      policies: [],
    });
    expect(report.result.status).toBe('succeeded');
    expect(report.steps.some((s) => s.kind === 'approval' && s.status === 'approved')).toBe(true);
  });
  it('wraps plain payloads into manual events', () => {
    expect(toEvent({ a: 1 })).toMatchObject({ type: 'io.openagentix.manual', data: { a: 1 } });
  });
});

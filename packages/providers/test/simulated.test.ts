import { describe, expect, it } from 'vitest';
import { SimulatedProvider, defaultToolName, renderTemplate } from '../src/index.js';

describe('SimulatedProvider', () => {
  const script = [
    {
      toolCalls: [
        {
          server: 'cve-db',
          tool: 'lookup_cve',
          args: { cveId: '{{event.data.cve}}', n: '{{event.data.n}}' },
        },
      ],
    },
    {
      text: 'Severity {{lastToolResult.severity}} for {{event.data.cve}} {{missing}}',
      usage: { inputTokens: 5, outputTokens: 2 },
    },
  ];
  const ctx = { event: { data: { cve: 'CVE-2024-1', n: 3 } } };

  it('replays the script turn by turn with templates', async () => {
    const p = new SimulatedProvider({ name: 'simulated' });
    const first = await p.complete({
      model: 'sim',
      messages: [{ role: 'user', content: 'go' }],
      hints: { simulation: script, context: ctx },
    });
    expect(first.toolCalls).toEqual([
      { id: 'sim_0_0', name: 'cve-db__lookup_cve', args: { cveId: 'CVE-2024-1', n: 3 } },
    ]);
    expect(first.stopReason).toBe('tool_use');
    const second = await p.complete({
      model: 'sim',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'sim_0_0', name: 'x', content: '{"severity":"HIGH"}' },
      ],
      hints: { simulation: script, context: ctx },
    });
    expect(second).toEqual({
      text: 'Severity HIGH for CVE-2024-1 ',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 2 },
      stopReason: 'end_turn',
      model: 'sim',
    });
  });

  it('is deterministic and falls back when the script is exhausted', async () => {
    const p = new SimulatedProvider({
      name: 's',
      responses: [{ text: 'only' }],
      clearance: 'public',
      toolName: (s, t) => `${s}.${t}`,
    });
    const a = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    const b = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(a).toEqual(b);
    expect(a.text).toBe('only');
    const fallback = await p.complete({
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'only' },
      ],
    });
    expect(fallback.text).toMatch(/Simulated response/);
    expect(p.clearance).toBe('public');
  });

  it('keeps non-JSON tool output as string and honours latency/abort', async () => {
    const p = new SimulatedProvider({ name: 's', latencyMs: 1 });
    const r = await p.complete({
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '' },
        { role: 'tool', toolCallId: '1', name: 't', content: 'plain' },
      ],
      hints: { simulation: [{ text: 'a' }, { text: '{{lastToolResult}}' }] },
    });
    expect(r.text).toBe('plain');
    const ac = new AbortController();
    ac.abort();
    await expect(p.complete({ model: 'm', messages: [] }, { signal: ac.signal })).rejects.toThrow();
  });
});

describe('templates', () => {
  it('renders nested structures and keeps types for whole-value templates', () => {
    expect(renderTemplate({ a: ['{{x.y}}', 'v={{x}}'], b: 1, c: null }, { x: { y: 2 } })).toEqual({
      a: [2, 'v={"y":2}'],
      b: 1,
      c: null,
    });
    expect(renderTemplate('{{nope}}', {})).toBe('');
    expect(renderTemplate('{{a.b}}', { a: 'str' })).toBe('');
    expect(renderTemplate('n={{a}}', { a: null })).toBe('n=');
  });
  it('builds safe tool names', () => {
    expect(defaultToolName('cve-db', 'lookup.cve')).toBe('cve-db__lookup_cve');
    expect(defaultToolName('s', 'x'.repeat(100))).toHaveLength(64);
  });
});

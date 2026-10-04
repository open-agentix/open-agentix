#!/usr/bin/env node
// Test double for `opencode run --format json`: the scenario is chosen by the prompt on stdin
// ("scenario: <name>"). Reads the generated config (OPENCODE_CONFIG) and talks to the policy gate
// exactly like the real CLI would, so the whole run passes through the gate.
import { readFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

const prompt = readFileSync(0, 'utf8');
const scenario = /scenario\W+(\w+)/.exec(prompt)?.[1] ?? 'ok';
const out = (o) => process.stdout.write(`${JSON.stringify({ sessionID: 'ses_1', ...o })}\n`);
const start = () => out({ type: 'step_start', part: { type: 'step-start' } });
const finish = (cost = 0.002, reason = 'stop') =>
  out({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      reason,
      cost,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 5 } },
    },
  });
const text = (t) => out({ type: 'text', part: { type: 'text', text: t } });
const tool = (callID, name, input, state) =>
  out({ type: 'tool_use', part: { type: 'tool', callID, tool: name, state: { input, ...state } } });

const config = process.env.OPENCODE_CONFIG
  ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'))
  : {};
const gate = Object.values(config.mcp ?? {})[0];

async function callGate(name, args) {
  const res = await fetch(gate.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: gate.headers.Authorization,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const r = (await res.json()).result;
  return { text: r.content.map((c) => c.text).join(''), isError: r.isError === true };
}

if (scenario === 'plain') {
  start();
  text('plain answer');
  finish();
} else if (scenario === 'ok') {
  start();
  const r = await callGate('cve-db__lookup_cve', { cveId: 'CVE-2024-3094' });
  tool(
    'c1',
    'oax-gate_cve-db__lookup_cve',
    { cveId: 'CVE-2024-3094' },
    {
      status: 'completed',
      output: r.text,
    },
  );
  finish(0.001, 'tool-calls');
  out('not json');
  process.stdout.write('plain log line\n');
  start();
  text('final answer');
  finish(0.0012);
} else if (scenario === 'denied') {
  start();
  const r = await callGate('tickets__add_comment', { key: 'SEC-1', comment: 'x' });
  tool(
    'c1',
    'oax-gate_tickets__add_comment',
    { key: 'SEC-1', comment: 'x' },
    {
      status: 'error',
      error: r.text,
    },
  );
  finish(0.001, 'tool-calls');
  start();
  text(`gate said: ${r.text}`);
  finish();
} else if (scenario === 'builtin') {
  start();
  tool('c1', 'bash', { command: 'id' }, { status: 'completed', output: 'uid=0' });
  finish();
} else if (scenario === 'steps') {
  for (let i = 0; i < 8; i++) {
    start();
    finish(0, 'tool-calls');
  }
  setInterval(() => undefined, 1000);
} else if (scenario === 'cost') {
  start();
  finish(7.5, 'tool-calls');
  setInterval(() => undefined, 1000);
} else if (scenario === 'hang') {
  start();
  setInterval(() => undefined, 1000);
} else if (scenario === 'env') {
  start();
  text(
    JSON.stringify({
      keys: Object.keys(process.env).sort(),
      home: process.env.HOME,
      cwd: process.cwd(),
      args: process.argv.slice(2),
      key: process.env.OAX_OPENCODE_API_KEY ?? null,
      config,
    }),
  );
  finish();
} else if (scenario === 'leak') {
  start();
  const key = process.env.OAX_OPENCODE_API_KEY ?? 'none';
  tool('c1', 'oax-gate_x', { k: 1 }, { status: 'completed', output: `echo ${key}` });
  text(`my key is ${key} and ${gate.headers.Authorization}`);
  finish();
} else if (scenario === 'error') {
  start();
  out({ type: 'error', error: { name: 'APIError', data: { message: 'rate limited' } } });
  process.exit(1);
} else if (scenario === 'crash') {
  process.stderr.write('boom Bearer abcdefghijklmnop\n');
  process.exit(3);
} else if (scenario === 'noresult') {
  start();
  text('partial');
} else {
  start();
  text(`unknown scenario ${scenario}`);
  finish();
}

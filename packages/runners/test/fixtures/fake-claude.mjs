#!/usr/bin/env node
// Stand-in for the `claude` binary: behaviour is chosen by the prompt on stdin.
import { readFileSync } from 'node:fs';
import { setInterval } from 'node:timers';
const prompt = readFileSync(0, 'utf8').trim();
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const init = { type: 'system', subtype: 'init', model: 'fake-model', session_id: 'sess-1' };
const result = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'final answer',
  total_cost_usd: 0.0123,
  num_turns: 2,
  session_id: 'sess-1',
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 5,
    output_tokens: 7,
  },
  ...extra,
});
const assistant = (id, content) => ({ type: 'assistant', message: { id, content } });
const toolUse = (id, name) => ({ type: 'tool_use', id, name, input: { a: 1 } });

if (prompt === 'ok') {
  out(init);
  out('not json at all');
  process.stdout.write('\n');
  out(assistant('m1', [toolUse('t1', 'mcp__oax-gate__x')]));
  out({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'tool says hi' }],
        },
      ],
    },
  });
  out({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't2', content: 'orphan', is_error: true },
        { type: 'text' },
      ],
    },
  });
  out(assistant('m2', [{ type: 'text', text: 'final answer' }]));
  out(result());
} else if (prompt === 'string-result') {
  out(assistant('m1', [toolUse('t1', 'Bash')]));
  out({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000), is_error: true },
      ],
    },
  });
  out(result({ result: `leaked ${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'none'}` }));
} else if (prompt === 'env') {
  out(
    result({
      result: JSON.stringify({
        keys: Object.keys(process.env).sort(),
        home: process.env.HOME,
        token: process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? process.env.CLAUDE_CODE_OAUTH_TOKEN === 'tok-1234567890-abcdef'
            ? 'match'
            : 'other'
          : null,
        cwd: process.cwd(),
        args: process.argv.slice(2),
      }),
    }),
  );
} else if (prompt === 'proxy-env') {
  // Through the model proxy: reports what the CLI would see (never the token itself).
  const e = process.env;
  out(
    result({
      result: JSON.stringify({
        keys: Object.keys(e).sort(),
        base: e.ANTHROPIC_BASE_URL,
        model: e.ANTHROPIC_MODEL,
        small: e.ANTHROPIC_SMALL_FAST_MODEL,
        haiku: e.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        tokenKind: (e.ANTHROPIC_AUTH_TOKEN ?? '').split('.')[0],
        oauth: e.CLAUDE_CODE_OAUTH_TOKEN ?? null,
        apiKey: e.ANTHROPIC_API_KEY ?? null,
        home: e.HOME,
        echoed: `token=${e.ANTHROPIC_AUTH_TOKEN}`,
      }),
    }),
  );
} else if (prompt === 'proxy-call') {
  // Calls the proxy like the CLI does: POST <base>/v1/messages with the auth token as bearer.
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 5, messages: [] }),
  });
  out(result({ result: `proxy answered ${res.status}` }));
} else if (prompt === 'turns') {
  for (let i = 0; i < 6; i++) out(assistant(`m${i}`, [{ type: 'text', text: 't' }]));
  setInterval(() => undefined, 1000);
} else if (prompt === 'maxturns') {
  out(assistant('m1', [{ type: 'text', text: 't' }]));
  out(result({ subtype: 'error_max_turns', is_error: true, result: '' }));
} else if (prompt === 'maxbudget') {
  out(result({ subtype: 'error_max_budget_usd', is_error: true, result: '' }));
} else if (prompt === 'error') {
  out(result({ subtype: 'error_during_execution', is_error: true, result: '' }));
} else if (prompt === 'crash') {
  process.stderr.write('boom Bearer abcdefghijklmnop\n');
  process.exit(3);
} else if (prompt === 'hang') {
  out(init);
  setInterval(() => undefined, 1000);
} else if (prompt === 'big') {
  const line = `${JSON.stringify({ type: 'noise', pad: 'x'.repeat(1_000_000) })}\n`;
  setInterval(() => process.stdout.write(line.repeat(4)), 5);
} else {
  out(result({ result: `unknown prompt ${prompt}` }));
}

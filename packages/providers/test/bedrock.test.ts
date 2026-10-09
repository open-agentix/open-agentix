import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { BedrockProvider, createBedrockClient, type BedrockConverseClient } from '../src/index.js';

function fakeClient(output: unknown) {
  const inputs: unknown[] = [];
  const client: BedrockConverseClient = {
    send: async (cmd) => {
      expect(cmd).toBeInstanceOf(ConverseCommand);
      inputs.push(cmd.input);
      return output as never;
    },
  };
  return { client, inputs };
}

describe('BedrockProvider', () => {
  it('maps Converse requests and responses', async () => {
    const { client, inputs } = fakeClient({
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'ok ' },
            { toolUse: { toolUseId: 'u1', name: 'cve__lookup', input: { id: 'CVE-1' } } },
            { toolUse: {} },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 6 },
    });
    const p = new BedrockProvider({ name: 'bedrock', region: 'eu-central-1', client });
    const res = await p.complete({
      model: 'anthropic.claude-opus-5-5',
      system: 'sys',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'a',
          toolCalls: [
            { id: 'x', name: 't', args: { q: 1 } },
            { id: 'y', name: 't', args: {} },
          ],
        },
        { role: 'tool', toolCallId: 'x', name: 't', content: 'r' },
        { role: 'tool', toolCallId: 'y', name: 't', content: 'e', isError: true },
        { role: 'assistant', content: '' },
      ],
      tools: [{ name: 't', inputSchema: { type: 'object' } }],
      maxTokens: 300,
      temperature: 0.1,
    });
    expect(res).toEqual({
      text: 'ok ',
      toolCalls: [
        { id: 'u1', name: 'cve__lookup', args: { id: 'CVE-1' } },
        { id: 'call_1', name: '', args: {} },
      ],
      usage: { inputTokens: 20, outputTokens: 6 },
      stopReason: 'tool_use',
      model: 'anthropic.claude-opus-5-5',
    });
    expect(inputs[0]).toMatchObject({
      modelId: 'anthropic.claude-opus-5-5',
      system: [{ text: 'sys' }],
      inferenceConfig: { maxTokens: 300, temperature: 0.1 },
      toolConfig: {
        tools: [
          { toolSpec: { name: 't', description: 't', inputSchema: { json: { type: 'object' } } } },
        ],
      },
    });
    const messages = (inputs[0] as { messages: { role: string; content: unknown[] }[] }).messages;
    expect(messages).toHaveLength(4);
    expect(messages[2]?.content).toEqual([
      { toolResult: { toolUseId: 'x', content: [{ text: 'r' }], status: 'success' } },
      { toolResult: { toolUseId: 'y', content: [{ text: 'e' }], status: 'error' } },
    ]);
    expect(p.clearance).toBe('confidential');
  });

  it('handles empty output and guardrail stops', async () => {
    const { client, inputs } = fakeClient({ stopReason: 'guardrail_intervened' });
    const p = new BedrockProvider({
      name: 'b',
      region: 'us-east-1',
      client,
      clearance: 'internal',
    });
    const res = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(res).toMatchObject({
      text: '',
      toolCalls: [],
      stopReason: 'refusal',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(inputs[0]).toEqual({
      modelId: 'm',
      messages: [{ role: 'user', content: [{ text: 'x' }] }],
    });
    const unknown = new BedrockProvider({ name: 'b', region: 'r', client: fakeClient({}).client });
    expect((await unknown.complete({ model: 'm', messages: [] })).stopReason).toBe('other');
  });

  it('configures VPC endpoint and proxy on the real client without network', async () => {
    const c = createBedrockClient({
      region: 'eu-central-1',
      endpoint: 'https://vpce-1.bedrock-runtime.eu-central-1.vpce.amazonaws.com',
      proxyUrl: 'http://proxy:3128',
      maxAttempts: 2,
    });
    const endpoint = await c.config.endpoint?.();
    expect(endpoint?.hostname).toBe('vpce-1.bedrock-runtime.eu-central-1.vpce.amazonaws.com');
    expect(await c.config.region()).toBe('eu-central-1');
    expect(createBedrockClient({ region: 'us-east-1' })).toBeTruthy();
    expect(new BedrockProvider({ name: 'b', region: 'us-east-1' }).kind).toBe('bedrock');
  });
});

describe('Bedrock custom endpoint of a tenant connection', () => {
  const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
  const guard = (address: string, allow: string[] = []) => ({
    allow,
    lookup: async () => [{ address }],
  });

  it('refuses a private endpoint before any request (adapter path)', async () => {
    const f = fakeClient({});
    const p = new BedrockProvider({
      name: 'b',
      region: 'r',
      endpoint: 'https://bedrock.internal',
      blockPrivateDestinations: guard('10.0.0.5'),
      client: f.client,
    });
    await expect(p.complete({ model: 'm', messages: [] })).rejects.toMatchObject({
      code: 'egress_denied',
    });
    expect(f.inputs).toHaveLength(0);
  });

  it('accepts a public endpoint, the operator allowlist and the default AWS endpoint', async () => {
    for (const g of [guard('8.8.8.8'), guard('10.0.0.5', ['10.0.0.0/8'])]) {
      const f = fakeClient({});
      const p = new BedrockProvider({
        name: 'b',
        region: 'r',
        endpoint: 'https://bedrock.internal',
        blockPrivateDestinations: g,
        client: f.client,
      });
      await p.complete({ model: 'm', messages: [] });
      expect(f.inputs).toHaveLength(1);
    }
  });

  it('pins the connection through a validating lookup and bounds the response size', async () => {
    let hits = 0;
    const server = createServer((_q, r) => {
      hits++;
      r.setHeader('content-type', 'application/json');
      r.end(
        JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: 'x'.repeat(5000) }] } },
        }),
      );
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as AddressInfo).port;
    try {
      const cmd = () =>
        new ConverseCommand({
          modelId: 'm',
          messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        });
      // a name that resolves to a private address never gets a connection
      const blocked = createBedrockClient({
        region: 'r',
        endpoint: `http://bedrock.internal:${port}`,
        credentials: creds,
        maxAttempts: 1,
        blockPrivateDestinations: guard('127.0.0.1'),
      });
      await expect(blocked.send(cmd())).rejects.toBeTruthy();
      expect(hits).toBe(0);
      // allowed destination: connected, but the oversized body is cut
      const limited = createBedrockClient({
        region: 'r',
        endpoint: `http://bedrock.internal:${port}`,
        credentials: creds,
        maxAttempts: 1,
        maxResponseBytes: 1000,
        blockPrivateDestinations: guard('127.0.0.1', ['127.0.0.1']),
      });
      await expect(limited.send(cmd())).rejects.toBeTruthy();
      expect(hits).toBe(1);
      const roomy = createBedrockClient({
        region: 'r',
        endpoint: `http://bedrock.internal:${port}`,
        credentials: creds,
        maxAttempts: 1,
        maxResponseBytes: 100_000,
        blockPrivateDestinations: guard('127.0.0.1', ['127.0.0.1']),
      });
      const ok = await roomy.send(cmd());
      expect(ok.output?.message?.content?.[0]?.text).toHaveLength(5000);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
});

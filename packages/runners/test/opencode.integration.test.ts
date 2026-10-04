import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentDefinition } from '@openagentix/core';
import type { ProviderConfig } from '@openagentix/providers';
import { describe, expect, it } from 'vitest';
import { OpenCodeHarness, executeWithHarness } from '../src/index.js';
import { prepared, setup } from './helpers.js';

/**
 * Opt-in: runs the REAL `opencode` binary (skipped unless OAX_TEST_OPENCODE=1).
 *
 * Required: OAX_TEST_OPENCODE_BASE_URL (OpenAI-compatible endpoint, for example a local Ollama
 * `http://127.0.0.1:11434/v1`), OAX_TEST_OPENCODE_MODEL. Optional: OAX_TEST_OPENCODE_CMD (absolute
 * path of the pinned binary), OAX_TEST_OPENCODE_SHA256, OAX_TEST_OPENCODE_API_KEY (passed as the
 * secret `llm-key`, never printed). See docs/verification/opencode-harness.md.
 */
const enabled = process.env.OAX_TEST_OPENCODE === '1';

describe.skipIf(!enabled)('OpenCode harness (real binary)', () => {
  it('runs one agent through the policy gate with a hard step limit', async () => {
    const baseUrl = process.env.OAX_TEST_OPENCODE_BASE_URL;
    const model = process.env.OAX_TEST_OPENCODE_MODEL;
    if (!baseUrl || !model) throw new Error('OAX_TEST_OPENCODE_BASE_URL and _MODEL are required');
    const key = process.env.OAX_TEST_OPENCODE_API_KEY;
    const def = loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: opencode-check
version: 1.0.0
owner: team
classification: internal
budget:
  maxSteps: 4
  timeoutSeconds: 180
agents:
  - id: lookup
    provider: llm
    model: ${model}
    instructions: You are a terse security assistant. Use the tool, then answer in one sentence.
    tools:
      - server: cve-db
        tool: lookup_cve
        allowAdditionalArgs: true
---
`);
    const provider = {
      kind: 'openai-compatible',
      name: 'llm',
      baseUrl,
      ...(key ? { apiKeySecret: 'llm-key' } : {}),
    } as ProviderConfig;
    const { ctx, control, tools } = setup(def);
    const harness = new OpenCodeHarness({
      ...(process.env.OAX_TEST_OPENCODE_CMD ? { command: process.env.OAX_TEST_OPENCODE_CMD } : {}),
      ...(process.env.OAX_TEST_OPENCODE_SHA256
        ? { expectedSha256: process.env.OAX_TEST_OPENCODE_SHA256 }
        : {}),
      providers: [provider],
      secrets: { resolve: async () => key ?? '' },
    });
    const workRoot = mkdtempSync(join(tmpdir(), 'oax-opencode-it-'));
    try {
      const result = await executeWithHarness(
        prepared(def, { question: 'How severe is CVE-2024-3094?' }),
        ctx,
        harness,
        { workRoot },
      );
      await tools.close();
      expect(control.verifyAudit().valid).toBe(true);
      expect(['succeeded', 'failed']).toContain(result.status);
      // whatever the model did, nothing outside the gate may have run
      expect(result.error?.code).not.toBe('harness_unmanaged_tool');
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 240_000);
});

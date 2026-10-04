import { NotImplementedError } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { RUNNER_CONFIG_SCHEMAS, StubRunner, type StubRunnerKind } from '../src/index.js';

describe('stub runners', () => {
  it.each(Object.keys(RUNNER_CONFIG_SCHEMAS).filter((k) => k !== 'kubernetes-job'))(
    '%s validates config and throws NotImplemented',
    async (kind) => {
      const configs: Record<string, unknown> = {
        'aws-lambda': { region: 'eu-central-1', roleArn: 'arn:aws:iam::1:role/x' },
        'github-actions': {
          repository: 'acme/repo',
          tokenSecret: 'gh',
          callbackBaseUrl: 'https://oax.example',
        },
        'gitlab-ci': {
          projectId: '1',
          triggerTokenSecret: 'gl',
          callbackBaseUrl: 'https://oax.example',
        },
      };
      const r = new StubRunner(kind as StubRunnerKind, configs[kind] ?? {});
      expect(r.kind).toBe(kind);
      await expect(r.execute({} as never, {} as never)).rejects.toThrow(NotImplementedError);
      await expect(r.execute({} as never, {} as never)).rejects.toThrow(/planned for v0\.[23]/);
    },
  );
  it('rejects invalid config', () => {
    expect(() => new StubRunner('github-actions', { repository: 'nope' })).toThrow();
    expect(RUNNER_CONFIG_SCHEMAS['kubernetes-job'].parse({}).serviceAccountName).toBe(
      'openagentix-run-node',
    );
  });
});

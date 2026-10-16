import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggableError } from '../src/errors.js';

const CANARY = 'CANARY-5d2f8a1cT7yQ0wLm3Zk9PxRs6Vn';

/** A failed statement as the driver reports it: the bound parameters and the failing row. */
const failed = () =>
  new DrizzleQueryError('insert into "t" ("body") values ($1)', [CANARY], {
    name: 'error',
    message: `new row violates check constraint; Failing row contains (${CANARY})`,
    code: '23514',
    severity: 'ERROR',
    detail: `Failing row contains (${CANARY})`,
    constraint: 't_check',
    table: 't',
  } as unknown as Error);

function logged(err: unknown): string {
  let out = '';
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      out += chunk.toString();
      cb();
    },
  });
  pino({ level: 'error' }, stream).error({ err: loggableError(err) }, 'unhandled error');
  return out;
}

describe('loggableError', () => {
  it('keeps the code, constraint, table and placeholders of a failed statement, nothing else', () => {
    const text = logged(failed());
    expect(text).not.toContain(CANARY);
    expect(text).toContain('database statement failed');
    expect(text).toContain('23514');
    expect(text).toContain('t_check');
    expect(text).toContain('insert into');
  });

  it('finds a failed statement anywhere in the cause chain of a wrapper', () => {
    const wrapper = new Error('could not save', {
      cause: new Error('retry gave up', { cause: failed() }),
    });
    const text = logged(wrapper);
    expect(text).not.toContain(CANARY);
    expect(text).toContain('database statement failed');
  });

  it('treats any error whose message holds a failed query as a database error', () => {
    const odd = new Error(`Failed query: insert ...\nparams: ${CANARY}`);
    expect(logged(odd)).not.toContain(CANARY);
    expect(logged(new Error('wrapped', { cause: odd }))).not.toContain(CANARY);
  });

  it('leaves other errors alone', () => {
    const plain = new Error('something else');
    expect(loggableError(plain)).toBe(plain);
    expect(loggableError('text')).toBe('text');
    expect(loggableError(null)).toBeNull();
  });
});

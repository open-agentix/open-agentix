import { Worker } from 'node:worker_threads';
import { WorkspaceError } from './errors.js';

export interface SearchLine {
  path: string;
  line: number;
  text: string;
}

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
const hits = [];
for (let i = 0; i < workerData.lines.length; i += 1) {
  if (re.test(workerData.lines[i])) hits.push(i);
}
parentPort.postMessage(hits);
`;

/**
 * Regular-expression matching in a worker thread that is terminated after `timeoutMs`, so a
 * catastrophic pattern ("ReDoS") cannot stall the server. Returns indexes of matching texts.
 */
export function regexMatches(
  pattern: string,
  ignoreCase: boolean,
  texts: readonly string[],
  timeoutMs: number,
): Promise<number[]> {
  let flags = 'u';
  if (ignoreCase) flags += 'i';
  try {
    new RegExp(pattern, flags);
  } catch {
    return Promise.reject(new WorkspaceError('bad_pattern', 'the search pattern is not valid'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { pattern, flags, lines: texts },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new WorkspaceError('search_timeout', 'the search pattern took too long'));
    }, timeoutMs);
    worker.once('message', (hits: number[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(hits);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new WorkspaceError('search_failed', 'the search failed'));
    });
  });
}

export function literalMatches(
  needle: string,
  ignoreCase: boolean,
  texts: readonly string[],
): number[] {
  const n = ignoreCase ? needle.toLowerCase() : needle;
  const hits: number[] = [];
  texts.forEach((t, i) => {
    if ((ignoreCase ? t.toLowerCase() : t).includes(n)) hits.push(i);
  });
  return hits;
}

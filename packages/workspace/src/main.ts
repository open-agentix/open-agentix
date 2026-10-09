#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Workspace } from './workspace.js';
import { serveStdio } from './server.js';

/**
 * stdio entry point started by the run node inside the checkout.
 *   oax-workspace --config <file.json> [--result <file.json>]
 * The configuration file is written by the node (never by the model). On shutdown the final result
 * (patch, digest, last test run) is written to `--result` if given.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configPath = arg('--config');
  if (!configPath)
    throw new Error('usage: oax-workspace --config <file.json> [--result <file.json>]');
  const ws = await Workspace.open(JSON.parse(await readFile(configPath, 'utf8')));
  const server = await serveStdio(ws);
  const resultPath = arg('--result');
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    if (resultPath)
      await writeFile(resultPath, JSON.stringify(await ws.finalize()), { mode: 0o600 });
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.once('end', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((e: unknown) => {
  console.error(`oax-workspace: ${(e as Error).message}`);
  process.exit(1);
});

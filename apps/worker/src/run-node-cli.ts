import { runNode } from './run-node.js';

/** Entry point of the run node image target: `node dist/run-node-cli.js`. */
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort(new Error('terminated')));
process.on('SIGINT', () => controller.abort(new Error('interrupted')));
process.exitCode = await runNode({ signal: controller.signal });

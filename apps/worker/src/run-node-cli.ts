import { runNode } from './run-node.js';

/** Entry point of the run node image target: `node dist/run-node-cli.js`. */
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort(new Error('terminated')));
process.on('SIGINT', () => controller.abort(new Error('interrupted')));
// Hard lifetime set by the runner: the node ends by itself even if the orchestrator is gone.
const deadline = Number(process.env.OAX_NODE_DEADLINE_SECONDS);
if (Number.isFinite(deadline) && deadline > 0)
  setTimeout(() => process.exit(124), deadline * 1000).unref();
process.exitCode = await runNode({ signal: controller.signal });

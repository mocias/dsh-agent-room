'use strict';
/**
 * Bridge a stdio ACP conversation onto Qoder's own worker thread.
 *
 * Qoder's desktop app is not a CLI and takes no `--acp` or `acp` subcommand: its
 * ACP surface lives in an SDK worker that the app loads with
 * `worker_threads`. So the only way to speak ACP to a Qoder install is to start
 * Qoder's own binary as node and have IT load that worker — which is this file.
 *
 * The launch line the registry derives is therefore:
 *
 *   <Qoder CN.exe>  <this file>  <.../qoder-worker-runtime.obf.mjs>
 *   with ELECTRON_RUN_AS_NODE=1
 *
 * and this process is the intermediary: the ACP pool talks JSON-RPC to our
 * stdin/stdout, we pipe it through the worker's stdin/stdout, and the worker
 * (running inside Qoder's binary, which has the SDK and its native pieces)
 * answers in the same protocol. Neither side needs to know about the other.
 *
 * Three details are load-bearing:
 *
 *   - **stdout carries protocol JSON only.** Anything we print to stdout that is
 *     not JSON-RPC corrupts the stream and the pool fails with a parse error
 *     that points nowhere near the cause. Diagnostics go to stderr.
 *   - **The worker is given the cwd we were started in**, both as `QODER_WORKER_CWD`
 *     and in `workerData`, because the SDK resolves the session workspace from
 *     the worker's environment rather than from `session/new` alone.
 *   - **EOF and signals must terminate the worker.** The pool closes our stdin to
 *     shut the session down; a worker that outlives us would keep a Qoder process
 *     alive per session, which is the leak this whole module exists to avoid.
 *
 * `login` as the third argument drops the ACP flag and hands the worker Qoder's
 * own login flow, so authentication can be completed without the desktop UI.
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const entry = process.argv[2];
if (!entry || !path.isAbsolute(entry)) {
  process.stderr.write('agent-room: missing or relative Qoder worker runtime path\n');
  process.exit(2);
}

const login = process.argv[3] === 'login';
const cwd = process.cwd();

const worker = new Worker(entry, {
  // The SDK decides its mode from argv; `--acp` is what makes it a server rather
  // than a one-shot task runner.
  argv: login ? ['login'] : ['--acp'],
  stdin: true,
  stdout: true,
  stderr: true,
  env: { ...process.env, QODER_WORKER_CWD: cwd },
  // `materialized: false` says the runtime is Qoder's own shipped file, not a copy
  // we unpacked. Copying it would both bloat this plugin and redistribute Qoder's
  // proprietary runtime, which is why the install stays where Qoder put it.
  workerData: { qoderWorkerRuntime: { cwd, runtimeRoot: path.dirname(entry), materialized: false } },
});

process.stdin.pipe(worker.stdin);
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);

worker.on('error', (error) => {
  process.stderr.write(`agent-room: qoder worker failed: ${error && error.message}\n`);
  process.exitCode = 1;
});
worker.on('exit', (code) => {
  process.exitCode = code;
  process.stdin.destroy();
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void worker.terminate();
};
// A login run is interactive and ends when the worker says so, not when stdin
// closes (there is no pipe to close in that mode).
if (!login) process.stdin.on('end', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);

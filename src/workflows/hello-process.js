// Workflows: the orchestration logic.
//
// This file runs inside Temporal's deterministic sandbox. That means:
//   - No I/O here (no HTTP, no database, no file system, no Redis).
//   - No Date.now(), Math.random() or setTimeout from Node; use the
//     @temporalio/workflow APIs instead (sleep, uuid4, etc.).
//   - Anything with side effects belongs in an activity.
//
// Why: Temporal rebuilds a workflow's state by replaying its event history
// through this same code. The code must make the same decisions every time.

const { proxyActivities, sleep, log } = require('@temporalio/workflow');

// proxyActivities does not call the functions directly. It returns stubs that
// schedule an activity task on the server; a worker picks it up and runs it.
const { greet, recordCompletion } = proxyActivities({
  // Maximum time a single attempt may take before it is considered failed.
  startToCloseTimeout: '10 seconds',
});

/**
 * First workflow of the project: two activities with a durable pause between them.
 *
 * @param {string} name - Who to greet.
 * @param {number} pauseSeconds - How long to wait between the two steps.
 * @returns {Promise<{greeting: string, completion: string}>}
 */
async function helloProcess(name, pauseSeconds = 20) {
  log.info('Process started', { name, pauseSeconds });

  const greeting = await greet(name);

  // Durable timer: it lives on the Temporal server, not in this process.
  // If the worker dies during the pause, the workflow resumes when a worker comes back.
  await sleep(pauseSeconds * 1000);

  const completion = await recordCompletion(name);

  return { greeting, completion };
}

module.exports = { helloProcess };

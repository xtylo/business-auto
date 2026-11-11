// Worker: the process that actually executes workflow and activity code.
//
// The Temporal server never runs your code. It only stores state and hands out
// tasks. Workers poll a task queue, execute the task, and report the result.

const { NativeConnection, Worker } = require('@temporalio/worker');
const activities = require('./activities');
const config = require('./config');

async function run() {
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });

  try {
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      // Workflows are passed as a path, not as functions: the worker bundles
      // that file and loads it into the deterministic sandbox.
      workflowsPath: require.resolve('./workflows'),
      // Activities are passed as plain functions.
      activities,
    });

    console.log(
      `Worker listening on task queue "${config.taskQueue}" at ${config.temporalAddress}. Press Ctrl+C to stop.`
    );

    // Runs until the process receives a shutdown signal (Ctrl+C).
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});

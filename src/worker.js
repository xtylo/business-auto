// Worker: the process that actually executes workflow and activity code.
//
// The Temporal server never runs your code. It only stores state and hands out
// tasks. Workers poll a task queue, execute the task, and report the result.

const { NativeConnection, Runtime, Worker } = require('@temporalio/worker');
const activities = require('./activities');
const config = require('./config');

async function run() {
  // The Runtime is the SDK's process-wide core. Configuring it before anything
  // else makes it serve the SDK's own metrics in Prometheus format: task queue
  // latency, free execution slots, completed workflows, and many more.
  Runtime.install({
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: `0.0.0.0:${config.workerMetricsPort}`,
          // Seconds, like the API metrics. The SDK default is milliseconds.
          useSecondsForDurations: true,
        },
      },
    },
  });

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
      // Concurrency limits. Undefined keeps the SDK defaults.
      ...(config.workerMaxActivities && { maxConcurrentActivityTaskExecutions: config.workerMaxActivities }),
      ...(config.workerMaxWorkflowTasks && {
        maxConcurrentWorkflowTaskExecutions: config.workerMaxWorkflowTasks,
      }),
    });

    console.log(
      `Worker listening on task queue "${config.taskQueue}" at ${config.temporalAddress}. Press Ctrl+C to stop.`
    );
    console.log(
      `Concurrency: activities=${config.workerMaxActivities || 'default'}, workflow tasks=${
        config.workerMaxWorkflowTasks || 'default'
      }`
    );
    console.log(`Worker metrics on http://localhost:${config.workerMetricsPort}/metrics`);

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

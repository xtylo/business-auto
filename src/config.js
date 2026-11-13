// Central configuration. Every value can be overridden with an environment variable.

const numberFrom = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

module.exports = {
  temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  // The task queue is the "channel" that links whoever starts a workflow
  // with the workers able to execute it. Both sides must use the same name.
  taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'business-processes',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  port: numberFrom(process.env.PORT, 3000),

  // ---- Observability ---------------------------------------------------------
  // Metrics are served on their own ports, separate from the public API port,
  // so a load balancer that exposes the API does not expose the metrics.
  apiMetricsPort: numberFrom(process.env.API_METRICS_PORT, 9465),
  workerMetricsPort: numberFrom(process.env.WORKER_METRICS_PORT, 9464),

  // ---- Tuning knobs (used in the load-testing session) -----------------------
  // Set STATUS_CACHE=off to make every status read go to Temporal.
  statusCacheEnabled: (process.env.STATUS_CACHE || 'on').toLowerCase() !== 'off',
  // How many activities / workflow tasks one worker runs at the same time.
  // Left undefined, the SDK defaults apply.
  workerMaxActivities: numberFrom(process.env.WORKER_MAX_ACTIVITIES, undefined),
  workerMaxWorkflowTasks: numberFrom(process.env.WORKER_MAX_WORKFLOW_TASKS, undefined),
};

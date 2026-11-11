// Central configuration. Every value can be overridden with an environment variable.

module.exports = {
  temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  // The task queue is the "channel" that links whoever starts a workflow
  // with the workers able to execute it. Both sides must use the same name.
  taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'business-processes',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  port: Number(process.env.PORT) || 3000,
};

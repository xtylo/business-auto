// Entry point of the HTTP API: creates the real connections and starts listening.

const { createApp } = require('./app');
const { createTemporalClient } = require('../client');
const { createRedis } = require('../redis');
const { createMetrics } = require('./metrics');
const config = require('../config');

async function main() {
  // One Temporal connection and one Redis connection for the whole process,
  // shared by every request. Opening one per request would be slow and wasteful.
  const { client: temporalClient, connection } = await createTemporalClient();
  const redis = createRedis();

  const metrics = createMetrics();

  const app = createApp({
    temporalClient,
    redis,
    metrics,
    statusCacheEnabled: config.statusCacheEnabled,
  });

  const server = app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port}`);
    console.log(`Status cache: ${config.statusCacheEnabled ? 'on' : 'OFF'}`);
  });

  const metricsServer = metrics.startServer(config.apiMetricsPort);
  console.log(`API metrics on http://localhost:${config.apiMetricsPort}/metrics`);

  // Graceful shutdown: stop accepting requests, let the ones in flight finish,
  // then close the connections. Container platforms send SIGTERM before stopping.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    metricsServer.close();
    server.close(async () => {
      redis.disconnect();
      await connection.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('API failed to start:', err.message);
  process.exit(1);
});

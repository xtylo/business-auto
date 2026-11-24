// Entry point of the HTTP API: creates the real connections and starts listening.

const { createApp } = require('./app');
const { createTemporalClient } = require('../client');
const { createRedis } = require('../redis');
const { createMetrics } = require('./metrics');
const config = require('../config');

async function main() {
  // One Temporal connection and one Redis connection for the whole process,
  // shared by every request. Opening one per request would be slow and wasteful.
  // The first line of output, so the logs are never empty even if startup fails later.
  console.log(`API starting. Temporal: ${config.temporalAddress}, Redis: ${config.redisUrl}`);

  // Lazy: the API must not depend on Temporal being reachable at boot. See src/client.js.
  const { client: temporalClient, connection } = await createTemporalClient({ lazy: true });
  const redis = createRedis();

  const metrics = createMetrics();

  const app = createApp({
    temporalClient,
    redis,
    metrics,
    statusCacheEnabled: config.statusCacheEnabled,
  });

  // Express 5 calls the listen callback with an error when the port cannot be
  // opened, so the callback has to check before announcing anything.
  const server = app.listen(config.port, (err) => {
    if (err) exitOnListenError('API', config.port, err);
    console.log(`API listening on http://localhost:${config.port}`);
    console.log(`Status cache: ${config.statusCacheEnabled ? 'on' : 'OFF'}`);
  });

  const metricsServer = metrics.startServer(config.apiMetricsPort);
  metricsServer.on('error', (err) => exitOnListenError('API metrics', config.apiMetricsPort, err));
  metricsServer.on('listening', () => {
    console.log(`API metrics on http://localhost:${config.apiMetricsPort}/metrics`);
  });

  // Graceful shutdown: stop accepting requests, let the ones in flight finish,
  // then close the connections. Container platforms send SIGTERM before stopping.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    // Safety net: never hang on shutdown because of a connection that will not close.
    setTimeout(() => process.exit(0), 5000).unref();
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

function exitOnListenError(name, port, err) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `${name}: port ${port} is already in use. Another API process is probably still running: ` +
        'stop it with Ctrl+C in its terminal, or run: pkill -f src/api/server.js'
    );
  } else {
    console.error(`${name}: could not listen on port ${port}: ${err.message}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('API failed to start:', err.message);
  process.exit(1);
});

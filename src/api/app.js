// Express application factory.
//
// The app receives its dependencies instead of creating them. That keeps this
// file free of connections, so tests can build the app with fakes (session 5),
// and server.js decides what the real ones are.

const express = require('express');
const { createRoutes, errorHandler } = require('./routes');
const { createStore } = require('./store');

/**
 * @param {object} deps
 * @param {import('@temporalio/client').Client} deps.temporalClient
 * @param {import('ioredis').Redis} deps.redis
 */
function createApp({ temporalClient, redis }) {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  // Liveness check for load balancers. It answers without touching Temporal or
  // Redis on purpose: a slow dependency must not make the balancer kill the API.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api', createRoutes({ temporalClient, store: createStore(redis) }));

  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

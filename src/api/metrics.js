// Prometheus metrics for the API.
//
// The three questions these answer, for any time window:
//   Rate:     how many requests per second?        http_request_duration_seconds_count
//   Errors:   what share of them failed?           ...{status_code=~"5.."}
//   Duration: how long did they take (p50/p95/p99)? http_request_duration_seconds_bucket

const client = require('prom-client');
const http = require('http');

function createMetrics() {
  // A registry per instance (instead of the global one) keeps tests isolated.
  const registry = new client.Registry();

  // Process-level metrics: memory, CPU, garbage collection, event loop lag.
  // Event loop lag is the best single sign that a Node.js process is saturated.
  client.collectDefaultMetrics({ register: registry });

  const requestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests, by method, route and status code',
    labelNames: ['method', 'route', 'status_code'],
    // Buckets chosen around the 200 ms target: fine-grained below it, coarse above.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const statusCacheRequests = new client.Counter({
    name: 'status_cache_requests_total',
    help: 'Status reads, by whether Redis answered them (hit) or Temporal did (miss)',
    labelNames: ['result'],
    registers: [registry],
  });

  /** Express middleware that times every request. */
  function middleware(req, res, next) {
    const stopTimer = requestDuration.startTimer();

    res.on('finish', () => {
      // Use the route PATTERN (/api/process/:id), never the real URL: one label
      // value per invoice would create millions of time series.
      const baseUrl = res.locals.baseUrl !== undefined ? res.locals.baseUrl : req.baseUrl;
      const route = req.route ? `${baseUrl}${req.route.path}` : 'unmatched';
      stopTimer({ method: req.method, route, status_code: res.statusCode });
    });

    next();
  }

  /** Serves GET /metrics on its own port. */
  function startServer(port) {
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
    });
    return server.listen(port);
  }

  return {
    registry,
    middleware,
    startServer,
    recordCacheHit: () => statusCacheRequests.inc({ result: 'hit' }),
    recordCacheMiss: () => statusCacheRequests.inc({ result: 'miss' }),
  };
}

module.exports = { createMetrics };

// Tests for the API metrics and for the status-cache switch used in load testing.

const request = require('supertest');
const { createApp } = require('../../src/api/app');
const { createMetrics } = require('../../src/api/metrics');
const { createFakeRedis } = require('../helpers/fake-redis');
const { createFakeTemporalClient } = require('../helpers/fake-temporal');

const invoice = { id: 'INV-1', supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

function build(options = {}) {
  const temporalClient = createFakeTemporalClient();
  const metrics = createMetrics();
  const app = createApp({ temporalClient, redis: createFakeRedis(), metrics, ...options });
  return { app, metrics, temporalClient };
}

/** Value of one sample line in the Prometheus text output, or undefined. */
async function sample(metrics, line) {
  const text = await metrics.registry.metrics();
  const found = text.split('\n').find((l) => l.startsWith(line));
  return found ? Number(found.slice(line.length).trim()) : undefined;
}

describe('request metrics', () => {
  test('requests are counted by method, route pattern and status code', async () => {
    const { app, metrics } = build();
    await request(app).post('/api/start-process').send({ invoice });
    await request(app).get('/api/process/invoice-INV-1');
    await request(app).get('/api/process/invoice-INV-1');

    expect(
      await sample(
        metrics,
        'http_request_duration_seconds_count{method="POST",route="/api/start-process",status_code="202"}'
      )
    ).toBe(1);
    expect(
      await sample(
        metrics,
        'http_request_duration_seconds_count{method="GET",route="/api/process/:id",status_code="200"}'
      )
    ).toBe(2);
  });

  test('the label is the route pattern, not the URL, even when the request fails', async () => {
    const { app, metrics } = build();
    await request(app).get('/api/process/invoice-A');
    await request(app).get('/api/process/invoice-B');

    const text = await metrics.registry.metrics();
    expect(text).not.toContain('invoice-A');
    expect(
      await sample(
        metrics,
        'http_request_duration_seconds_count{method="GET",route="/api/process/:id",status_code="404"}'
      )
    ).toBe(2);
  });

  test('cache hits and misses are counted', async () => {
    const { app, metrics } = build();
    await request(app).post('/api/start-process').send({ invoice });
    await request(app).get('/api/process/invoice-INV-1'); // miss
    await request(app).get('/api/process/invoice-INV-1'); // hit
    await request(app).get('/api/process/invoice-INV-1'); // hit

    expect(await sample(metrics, 'status_cache_requests_total{result="miss"}')).toBe(1);
    expect(await sample(metrics, 'status_cache_requests_total{result="hit"}')).toBe(2);
  });
});

describe('status cache switch', () => {
  test('with the cache disabled, every read goes to Temporal', async () => {
    const { app, temporalClient } = build({ statusCacheEnabled: false });
    await request(app).post('/api/start-process').send({ invoice });

    const first = await request(app).get('/api/process/invoice-INV-1');
    const second = await request(app).get('/api/process/invoice-INV-1');

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('MISS');
    expect(temporalClient.calls.query).toBe(2);
  });
});

test('the app works without metrics', async () => {
  const app = createApp({ temporalClient: createFakeTemporalClient(), redis: createFakeRedis() });
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
});

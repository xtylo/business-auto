// Load test for the business-auto API.
//
// Run it from the host (the dev container has no Docker):
//   docker compose --profile loadtest run --rm k6 run /scripts/k6.js
//   docker compose --profile loadtest run --rm -e SCENARIO=ramp k6 run /scripts/k6.js
//   docker compose --profile loadtest run --rm -e SCENARIO=reads -e RATE=300 k6 run /scripts/k6.js
//
// Scenarios (SCENARIO):
//   smoke  5 processes per second for 30 s. Checks that everything works.
//   ramp   starts and approves processes at a rate that climbs step by step,
//          to find the point where the system stops keeping up.
//   reads  reads the status of a few running processes at a constant rate
//          (RATE, default 200 per second). Used to measure the Redis cache.
//
// All scenarios are "open model" (arrival rate): k6 starts iterations at the
// given rate whether or not earlier ones have finished, the way real clients
// do. A fixed number of virtual users would slow down together with the
// system and hide the saturation point.

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SCENARIO = __ENV.SCENARIO || 'smoke';
const RATE = Number(__ENV.RATE || 200);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const cacheHits = new Rate('status_cache_hits');

const scenarios = {
  smoke: {
    executor: 'constant-arrival-rate',
    exec: 'startAndApprove',
    rate: 5,
    timeUnit: '1s',
    duration: '30s',
    preAllocatedVUs: 20,
  },
  ramp: {
    executor: 'ramping-arrival-rate',
    exec: 'startAndApprove',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 200,
    maxVUs: 2000,
    // Each step holds for 30 s so the dashboard has time to settle.
    // One iteration is 2 HTTP requests, so 400 iterations/s is 800 requests/s.
    stages: [
      { target: 25, duration: '30s' },
      { target: 50, duration: '30s' },
      { target: 100, duration: '30s' },
      { target: 200, duration: '30s' },
      { target: 400, duration: '30s' },
    ],
  },
  reads: {
    executor: 'constant-arrival-rate',
    exec: 'readStatus',
    rate: RATE,
    timeUnit: '1s',
    duration: '60s',
    preAllocatedVUs: 200,
    maxVUs: 2000,
  },
};

if (!scenarios[SCENARIO]) {
  throw new Error(`Unknown SCENARIO "${SCENARIO}". Use one of: ${Object.keys(scenarios).join(', ')}`);
}

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] },
  // The targets from the project brief. Crossing them does not stop the test:
  // in the ramp scenario, finding where they break is the purpose.
  thresholds: {
    http_req_duration: ['p(99)<200'],
    http_req_failed: ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

// Runs once, before the load starts. Its return value is passed to every iteration.
export function setup() {
  // Unique per test run, so invoice IDs never collide with an earlier run.
  const runId = Date.now().toString(36);
  const ids = [];

  if (SCENARIO === 'reads') {
    // A few processes that stay waiting for approval during the whole test.
    for (let i = 0; i < 20; i++) {
      const invoiceId = `LOAD-${runId}-READ-${i}`;
      const res = http.post(
        `${BASE_URL}/api/start-process`,
        JSON.stringify({
          invoice: { id: invoiceId, supplier: 'Load Test', amount: 100, currency: 'MXN' },
          options: { approvalTimeoutSeconds: 3600 },
        }),
        { headers: JSON_HEADERS }
      );
      if (res.status !== 202) {
        throw new Error(`setup: could not start ${invoiceId}: ${res.status} ${res.body}`);
      }
      ids.push(`invoice-${invoiceId}`);
    }
  }

  return { runId, ids };
}

// One whole business process: start it, then approve it.
export function startAndApprove(data) {
  const invoiceId = `LOAD-${data.runId}-${__VU}-${__ITER}`;
  const workflowId = `invoice-${invoiceId}`;

  const started = http.post(
    `${BASE_URL}/api/start-process`,
    JSON.stringify({
      invoice: { id: invoiceId, supplier: 'Load Test', amount: 100, currency: 'MXN' },
      options: { approvalTimeoutSeconds: 600 },
    }),
    {
      headers: { ...JSON_HEADERS, 'Idempotency-Key': invoiceId },
      // The tag groups requests in the results under a fixed name.
      tags: { name: 'start-process' },
    }
  );
  if (!check(started, { 'start: 202': (r) => r.status === 202 })) return;

  const approved = http.post(
    `${BASE_URL}/api/process/${workflowId}/approve`,
    JSON.stringify({ approver: 'load.test' }),
    { headers: JSON_HEADERS, tags: { name: 'approve' } }
  );
  check(approved, { 'approve: 202': (r) => r.status === 202 });
}

// Reads the status of one of the processes created in setup().
export function readStatus(data) {
  const workflowId = data.ids[Math.floor(Math.random() * data.ids.length)];

  const res = http.get(`${BASE_URL}/api/process/${workflowId}`, { tags: { name: 'read-status' } });

  check(res, { 'status: 200': (r) => r.status === 200 });
  cacheHits.add(res.headers['X-Cache'] === 'HIT');
}

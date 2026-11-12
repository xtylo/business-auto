// API tests: real Express app, fake Temporal client, fake Redis.
//
// What is being tested is the HTTP contract: status codes, headers, and how
// the API uses its two dependencies. No server or network is needed.

const request = require('supertest');
const { createApp } = require('../../src/api/app');
const { createFakeRedis } = require('../helpers/fake-redis');
const { createFakeTemporalClient } = require('../helpers/fake-temporal');

const invoice = { id: 'INV-1', supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

let app;
let temporalClient;
let redis;

beforeEach(() => {
  temporalClient = createFakeTemporalClient();
  redis = createFakeRedis();
  app = createApp({ temporalClient, redis });
});

const startProcess = (body = { invoice }, key) => {
  const req = request(app).post('/api/start-process');
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

describe('GET /health', () => {
  test('answers without touching Temporal or Redis', async () => {
    redis.goDown();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/start-process', () => {
  test('starts a workflow and returns 202 with its location', async () => {
    const res = await startProcess({ invoice, options: { approvalTimeoutSeconds: 120 } });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ workflowId: 'invoice-INV-1', duplicate: false });
    expect(res.headers.location).toBe('/api/process/invoice-INV-1');
  });

  test('passes the invoice and options to the workflow, with the invoice ID as business key', async () => {
    await startProcess({ invoice, options: { approvalTimeoutSeconds: 120 } });

    const { options } = temporalClient.workflows.get('invoice-INV-1');
    expect(options.args).toEqual([invoice, { approvalTimeoutSeconds: 120 }]);
    expect(options.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE_FAILED_ONLY');
  });

  test('the same Idempotency-Key returns the original workflow without starting another', async () => {
    await startProcess({ invoice }, 'key-1');
    const res = await startProcess({ invoice }, 'key-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workflowId: 'invoice-INV-1', duplicate: true });
    expect(temporalClient.calls.start).toBe(1);
  });

  test('the same invoice with a different key is a conflict', async () => {
    await startProcess({ invoice }, 'key-1');
    const res = await startProcess({ invoice }, 'key-2');

    expect(res.status).toBe(409);
    expect(res.body.workflowId).toBe('invoice-INV-1');
  });

  test('a key whose request was rejected is released, so it can be used again', async () => {
    await startProcess({ invoice }, 'key-1');
    await startProcess({ invoice }, 'key-2'); // 409

    expect(redis.data.has('idem:key-2')).toBe(false);
  });

  test('an invoice whose process failed can be submitted again', async () => {
    await startProcess({ invoice });
    temporalClient.close('invoice-INV-1', 'FAILED', 'PAYMENT_REVERTED');

    const res = await startProcess({ invoice });
    expect(res.status).toBe(202);
  });

  test.each([
    ['an empty body', {}, 'invoice is required'],
    ['an invoice without id', { invoice: { supplier: 'Acme' } }, 'invoice.id is required'],
    ['an id with spaces', { invoice: { id: 'INV 1' } }, 'invoice.id is required'],
    ['a negative timeout', { invoice, options: { approvalTimeoutSeconds: -1 } }, 'approvalTimeoutSeconds'],
  ])('rejects %s with 400', async (_label, body, expectedDetail) => {
    const res = await startProcess(body);

    expect(res.status).toBe(400);
    expect(res.body.details.join(' ')).toContain(expectedDetail);
    expect(temporalClient.calls.start).toBe(0);
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/start-process')
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(res.status).toBe(400);
  });

  test('does not validate business rules: a negative amount is accepted for the workflow to judge', async () => {
    const res = await startProcess({ invoice: { ...invoice, amount: -5 } });
    expect(res.status).toBe(202);
  });
});

describe('GET /api/process/:id', () => {
  test('returns Temporal execution status together with the workflow state', async () => {
    await startProcess();
    const res = await request(app).get('/api/process/invoice-INV-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workflowId: 'invoice-INV-1',
      execution: 'RUNNING',
      status: 'AWAITING_APPROVAL',
      closedAt: null,
    });
  });

  test('the second read comes from the cache and does not query the workflow', async () => {
    await startProcess();
    const first = await request(app).get('/api/process/invoice-INV-1');
    const second = await request(app).get('/api/process/invoice-INV-1');

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
    expect(temporalClient.calls.query).toBe(1);
  });

  test('returns 404 for an unknown process', async () => {
    const res = await request(app).get('/api/process/invoice-NOPE');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/process/:id/approve and /reject', () => {
  test('approve sends the signal and returns 202', async () => {
    await startProcess();
    const res = await request(app)
      .post('/api/process/invoice-INV-1/approve')
      .send({ approver: 'ana.manager', comment: 'ok' });

    expect(res.status).toBe(202);
    expect(temporalClient.workflows.get('invoice-INV-1').state.decision).toEqual({
      approved: true,
      approver: 'ana.manager',
      comment: 'ok',
    });
  });

  test('a decision invalidates the cached status, so the next read is fresh', async () => {
    await startProcess();
    await request(app).get('/api/process/invoice-INV-1'); // caches AWAITING_APPROVAL
    await request(app).post('/api/process/invoice-INV-1/reject').send({ approver: 'ana', reason: 'dup' });

    const res = await request(app).get('/api/process/invoice-INV-1');
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.body.status).toBe('REJECTED');
  });

  test('a decision on a finished process is a conflict', async () => {
    await startProcess();
    await request(app).post('/api/process/invoice-INV-1/approve').send({ approver: 'ana' });

    const res = await request(app).post('/api/process/invoice-INV-1/reject').send({ approver: 'bob' });
    expect(res.status).toBe(409);
    expect(res.body.execution).toBe('COMPLETED');
    expect(temporalClient.calls.signal).toBe(1);
  });

  test('requires an approver', async () => {
    await startProcess();
    const res = await request(app).post('/api/process/invoice-INV-1/approve').send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for an unknown process', async () => {
    const res = await request(app).post('/api/process/invoice-NOPE/approve').send({ approver: 'ana' });
    expect(res.status).toBe(404);
  });
});

describe('when Redis is down', () => {
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    redis.goDown();
  });
  afterEach(() => warn.mockRestore());

  test('processes can still be started and read', async () => {
    const started = await startProcess({ invoice }, 'key-1');
    const read = await request(app).get('/api/process/invoice-INV-1');

    expect(started.status).toBe(202);
    expect(read.status).toBe(200);
    expect(read.headers['x-cache']).toBe('MISS');
    expect(warn).toHaveBeenCalled();
  });

  test('duplicates are still stopped, by the workflow ID', async () => {
    await startProcess({ invoice }, 'key-1');
    const res = await startProcess({ invoice }, 'key-1');

    // Without Redis the friendly 200 is gone, but the guarantee holds.
    expect(res.status).toBe(409);
    expect(temporalClient.workflows.size).toBe(1);
  });
});

test('unknown routes return a JSON 404', async () => {
  const res = await request(app).get('/api/nothing-here');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'Route not found' });
});

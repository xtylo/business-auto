// Smoke test: drives one invoice through the whole process over HTTP and checks
// each answer. It uses only what Node.js ships with, so it runs anywhere.
//
// Usage:
//   npm run smoke                              -> http://localhost:3000
//   npm run smoke -- http://my-load-balancer   -> a deployed environment

const baseUrl = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const invoiceId = `SMOKE-${Date.now()}`;
const workflowId = `invoice-${invoiceId}`;

async function call(method, path, body) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Could not reach ${baseUrl}${path}: ${err.cause ? err.cause.message : err.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    // Not JSON: leave it as null.
  }
  return { status: res.status, json, ms: Date.now() - startedAt };
}

function step(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) throw new Error(`Step failed: ${name}`);
}

/** Polls the process until `done(body)` is true or the time runs out. */
async function waitFor(description, done, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await call('GET', `/api/process/${workflowId}`);
    if (last.status === 200 && done(last.json)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const seen = last ? `${last.status} ${JSON.stringify(last.json)}` : 'no answer';
  throw new Error(`Timed out waiting for: ${description}. Last answer: ${seen}`);
}

async function main() {
  console.log(`Smoke test against ${baseUrl}`);
  console.log(`Invoice ${invoiceId}\n`);

  const health = await call('GET', '/health');
  step('API is up', health.status === 200, `${health.ms} ms`);

  const started = await call('POST', '/api/start-process', {
    invoice: { id: invoiceId, supplier: 'Smoke Test', amount: 100, currency: 'MXN' },
    options: { approvalTimeoutSeconds: 300 },
  });
  step('Process started', started.status === 202, `HTTP ${started.status}, ${started.ms} ms`);

  // Reaching this state proves the worker picked the workflow up and ran activities.
  await waitFor('status AWAITING_APPROVAL', (body) => body.status === 'AWAITING_APPROVAL');
  step('Worker is processing: waiting for approval', true);

  const approved = await call('POST', `/api/process/${workflowId}/approve`, { approver: 'smoke.test' });
  step('Approval accepted', approved.status === 202, `HTTP ${approved.status}, ${approved.ms} ms`);

  const finished = await waitFor('status PAID', (body) => body.status === 'PAID');
  step(
    'Process completed as PAID',
    finished.json.execution === 'COMPLETED',
    `payment ${finished.json.paymentId}`
  );

  const duplicate = await call('POST', '/api/start-process', {
    invoice: { id: invoiceId, supplier: 'Smoke Test', amount: 100, currency: 'MXN' },
  });
  step('Duplicate invoice rejected', duplicate.status === 409, `HTTP ${duplicate.status}`);

  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});

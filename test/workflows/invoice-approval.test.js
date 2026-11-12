// Workflow tests for invoiceApproval.
//
// These run the REAL workflow code on a REAL (in-memory) Temporal test server,
// with two differences from production:
//
//   1. Activities are replaced by mocks, so each test decides what "the outside
//      world" does and can assert on what the workflow asked for.
//   2. The server skips time. A timer of 5 days fires immediately when the test
//      is only waiting, so the expiry path runs in milliseconds.
//
// The first run downloads the test server (once), so it needs network access.

const { randomUUID } = require('crypto');
const { TestWorkflowEnvironment } = require('@temporalio/testing');
const { Worker, bundleWorkflowCode } = require('@temporalio/worker');
const { ApplicationFailure } = require('@temporalio/activity');

const FIVE_DAYS_IN_SECONDS = 5 * 24 * 60 * 60;
const SIX_DAYS_IN_MS = 6 * 24 * 60 * 60 * 1000;

const invoice = { id: 'INV-1', supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

let testEnv;
let workflowBundle;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  // Bundle the workflow code once and reuse it in every test.
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: require.resolve('../../src/workflows'),
  });
}, 180_000);

afterAll(async () => {
  if (testEnv) await testEnv.teardown();
});

/** Activity mocks where everything succeeds. A test overrides only what it needs. */
function mockActivities(overrides = {}) {
  return {
    validateInvoice: jest.fn(async () => ({ valid: true })),
    requestApproval: jest.fn(async (_invoice, level) => ({ requestedFrom: level })),
    recordPayment: jest.fn(async (inv) => ({
      paymentId: `pay-${inv.id}`,
      amount: inv.amount,
      currency: inv.currency,
    })),
    postToLedger: jest.fn(async () => ({ posted: true })),
    revertPayment: jest.fn(async (_invoice, payment) => ({ reverted: true, paymentId: payment.paymentId })),
    notify: jest.fn(async () => ({ sent: true })),
    ...overrides,
  };
}

/** A failure Temporal will not retry: keeps tests about failures fast and exact. */
function permanentFailure(message) {
  return ApplicationFailure.create({ message, nonRetryable: true });
}

/**
 * Starts a worker with the given activity mocks, starts one workflow, hands its
 * handle to `scenario`, and shuts the worker down when the scenario finishes.
 */
async function runScenario(activities, scenario, options = {}) {
  const taskQueue = `test-${randomUUID()}`;

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowBundle,
    activities,
  });

  return worker.runUntil(async () => {
    const handle = await testEnv.client.workflow.start('invoiceApproval', {
      taskQueue,
      workflowId: `invoice-${randomUUID()}`,
      args: [invoice, { approvalTimeoutSeconds: FIVE_DAYS_IN_SECONDS, ...options }],
    });
    return scenario(handle);
  });
}

describe('approval', () => {
  test('an approved invoice is paid, booked and notified', async () => {
    const activities = mockActivities();

    const result = await runScenario(activities, async (handle) => {
      await handle.signal('approve', { approver: 'ana.manager', comment: 'ok' });
      return handle.result();
    });

    expect(result).toMatchObject({
      status: 'PAID',
      paymentId: 'pay-INV-1',
      escalated: false,
      notified: true,
      decision: { approved: true, by: 'ana.manager', comment: 'ok' },
    });
    expect(activities.requestApproval).toHaveBeenCalledWith(invoice, 'manager');
    expect(activities.recordPayment).toHaveBeenCalledTimes(1);
    expect(activities.postToLedger).toHaveBeenCalledTimes(1);
    expect(activities.revertPayment).not.toHaveBeenCalled();
  });

  test('a rejected invoice is never paid, and the workflow completes normally', async () => {
    const activities = mockActivities();

    const result = await runScenario(activities, async (handle) => {
      await handle.signal('reject', { approver: 'ana.manager', reason: 'Duplicate invoice' });
      return handle.result();
    });

    expect(result).toMatchObject({
      status: 'REJECTED',
      paymentId: null,
      decision: { approved: false, by: 'ana.manager', reason: 'Duplicate invoice' },
    });
    expect(activities.recordPayment).not.toHaveBeenCalled();
    expect(activities.notify).toHaveBeenCalledTimes(1);
  });

  test('the first decision wins; a later one is ignored', async () => {
    const activities = mockActivities();

    const result = await runScenario(activities, async (handle) => {
      await handle.signal('reject', { approver: 'first', reason: 'no' });
      await handle.signal('approve', { approver: 'second' });
      return handle.result();
    });

    expect(result.status).toBe('REJECTED');
    expect(result.decision.by).toBe('first');
    expect(activities.recordPayment).not.toHaveBeenCalled();
  });
});

describe('timeouts', () => {
  test('with no answer the request escalates, then expires', async () => {
    const activities = mockActivities();

    // Nobody signals. Waiting for the result lets the server skip ten days.
    const result = await runScenario(activities, (handle) => handle.result());

    expect(result).toMatchObject({ status: 'EXPIRED', escalated: true, decision: null, paymentId: null });
    expect(activities.requestApproval).toHaveBeenNthCalledWith(1, invoice, 'manager');
    expect(activities.requestApproval).toHaveBeenNthCalledWith(2, invoice, 'director');
    expect(activities.recordPayment).not.toHaveBeenCalled();
  });

  test('an approval that arrives after escalation still pays the invoice', async () => {
    const activities = mockActivities();

    const result = await runScenario(activities, async (handle) => {
      // Move the clock past the first deadline but not the second.
      await testEnv.sleep(SIX_DAYS_IN_MS);
      expect((await handle.query('status')).status).toBe('ESCALATED');

      await handle.signal('approve', { approver: 'dora.director' });
      return handle.result();
    });

    expect(result).toMatchObject({ status: 'PAID', escalated: true });
    expect(result.decision.by).toBe('dora.director');
  });
});

describe('failures after approval', () => {
  test('when the ledger fails for good, the payment is reverted and the workflow fails', async () => {
    const activities = mockActivities({
      postToLedger: jest.fn(async () => {
        throw permanentFailure('ledger is down');
      }),
    });

    await runScenario(activities, async (handle) => {
      await handle.signal('approve', { approver: 'ana.manager' });

      await expect(handle.result()).rejects.toMatchObject({ name: 'WorkflowFailedError' });

      // A closed workflow can still be queried while a worker is running.
      expect(await handle.query('status')).toMatchObject({
        status: 'PAYMENT_REVERTED',
        paymentId: 'pay-INV-1',
      });
    });

    expect(activities.revertPayment).toHaveBeenCalledTimes(1);
    expect(activities.revertPayment).toHaveBeenCalledWith(
      invoice,
      expect.objectContaining({ paymentId: 'pay-INV-1' })
    );
    expect(activities.notify).not.toHaveBeenCalled();
  });

  test('when the payment itself fails, there is nothing to revert', async () => {
    const activities = mockActivities({
      recordPayment: jest.fn(async () => {
        throw permanentFailure('payment system is down');
      }),
    });

    await runScenario(activities, async (handle) => {
      await handle.signal('approve', { approver: 'ana.manager' });
      await expect(handle.result()).rejects.toMatchObject({ name: 'WorkflowFailedError' });
      expect((await handle.query('status')).status).toBe('FAILED');
    });

    expect(activities.revertPayment).not.toHaveBeenCalled();
    expect(activities.postToLedger).not.toHaveBeenCalled();
  });

  test('a notification that cannot be sent does not undo the payment', async () => {
    const activities = mockActivities({
      notify: jest.fn(async () => {
        throw permanentFailure('mail server is down');
      }),
    });

    const result = await runScenario(activities, async (handle) => {
      await handle.signal('approve', { approver: 'ana.manager' });
      return handle.result();
    });

    expect(result).toMatchObject({ status: 'PAID', notified: false });
    expect(activities.revertPayment).not.toHaveBeenCalled();
  });

  test('a transient payment failure is retried without involving the workflow code', async () => {
    let attempts = 0;
    const activities = mockActivities({
      recordPayment: jest.fn(async (inv) => {
        attempts++;
        if (attempts < 3) throw new Error('temporary outage');
        return { paymentId: `pay-${inv.id}`, amount: inv.amount, currency: inv.currency };
      }),
    });

    const result = await runScenario(activities, async (handle) => {
      await handle.signal('approve', { approver: 'ana.manager' });
      return handle.result();
    });

    expect(result.status).toBe('PAID');
    expect(activities.recordPayment).toHaveBeenCalledTimes(3);
  });
});

describe('validation', () => {
  test('an invalid invoice fails before anyone is asked to approve', async () => {
    const activities = mockActivities({
      validateInvoice: jest.fn(async () => {
        throw ApplicationFailure.create({
          type: 'InvalidInvoiceError',
          message: 'Invalid invoice: amount must be a number greater than 0',
          nonRetryable: true,
        });
      }),
    });

    await runScenario(activities, async (handle) => {
      await expect(handle.result()).rejects.toMatchObject({ name: 'WorkflowFailedError' });
    });

    expect(activities.requestApproval).not.toHaveBeenCalled();
  });
});

// Exercise for you. Remove ".todo", write the test, and make it pass:
// a signal can arrive at any moment, including before the workflow starts waiting.
test('an approval sent while the invoice is still being validated is not lost', async () => {
  // A "gate": validation stays in progress until the test decides to let it finish.
  let finishValidation;
  const validationGate = new Promise((resolve) => {
    finishValidation = resolve;
  });

  const activities = mockActivities({
    validateInvoice: jest.fn(async () => {
      await validationGate;
      return { valid: true };
    }),
  });

  const result = await runScenario(activities, async (handle) => {
    try {
      // The workflow has not reached the approval step yet.
      await handle.signal('approve', { approver: 'early.bird' });
      expect((await handle.query('status')).status).toBe('VALIDATING');
    } finally {
      // Always release the gate, or a failed assertion would leave the worker hanging.
      finishValidation();
    }
    return handle.result();
  });

  expect(result).toMatchObject({ status: 'PAID', escalated: false });
  expect(result.decision.by).toBe('early.bird');
  expect(activities.recordPayment).toHaveBeenCalledTimes(1);
});


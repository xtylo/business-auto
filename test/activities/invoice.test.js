// Unit tests for the invoice activities.
//
// Activities are ordinary functions, but they read their attempt number from
// Temporal's activity context. MockActivityEnvironment provides that context
// without any server, so these tests run in milliseconds.

const { MockActivityEnvironment } = require('@temporalio/testing');
const { DefaultLogger } = require('@temporalio/worker');
const activities = require('../../src/activities/invoice');

const invoice = { id: 'INV-1', supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

// Activities log through Temporal's logger. Keep the test output readable;
// set TEST_LOG_LEVEL=INFO to see everything.
const logger = new DefaultLogger(process.env.TEST_LOG_LEVEL || 'ERROR');

/** Runs an activity as if Temporal were executing the given attempt. */
function runActivity(fn, args, { attempt = 1 } = {}) {
  const env = new MockActivityEnvironment({ attempt }, { logger });
  return env.run(fn, ...args);
}

describe('validateInvoice', () => {
  test('accepts a complete invoice', async () => {
    await expect(runActivity(activities.validateInvoice, [invoice])).resolves.toEqual({ valid: true });
  });

  test.each([
    ['a negative amount', { amount: -5 }, 'amount must be a number greater than 0'],
    ['an unsupported currency', { currency: 'EUR' }, 'currency must be one of'],
    ['a missing supplier', { supplier: '' }, 'supplier is required'],
    ['a missing id', { id: undefined }, 'id is required'],
  ])('rejects %s', async (_label, change, expectedMessage) => {
    await expect(runActivity(activities.validateInvoice, [{ ...invoice, ...change }])).rejects.toThrow(
      expectedMessage
    );
  });

  test('marks the failure as non-retryable so Temporal does not try again', async () => {
    await expect(runActivity(activities.validateInvoice, [{ ...invoice, amount: 0 }])).rejects.toMatchObject({
      type: 'InvalidInvoiceError',
      nonRetryable: true,
    });
  });

  test('reports every problem at once', async () => {
    await expect(
      runActivity(activities.validateInvoice, [{ ...invoice, amount: -1, currency: 'EUR' }])
    ).rejects.toThrow(/amount.*currency/);
  });
});

describe('recordPayment', () => {
  test('derives the payment ID from the invoice ID, so a repeat is detectable', async () => {
    const first = await runActivity(activities.recordPayment, [invoice]);
    const second = await runActivity(activities.recordPayment, [invoice]);

    expect(first.paymentId).toBe('pay-INV-1');
    expect(second).toEqual(first);
  });

  test('fails while the attempt is within the simulated failures, then succeeds', async () => {
    const simulate = { recordPaymentFailures: 2 };

    await expect(runActivity(activities.recordPayment, [invoice, simulate], { attempt: 1 })).rejects.toThrow(
      'simulated outage'
    );
    await expect(runActivity(activities.recordPayment, [invoice, simulate], { attempt: 2 })).rejects.toThrow(
      'simulated outage'
    );
    await expect(
      runActivity(activities.recordPayment, [invoice, simulate], { attempt: 3 })
    ).resolves.toMatchObject({ paymentId: 'pay-INV-1' });
  });

  test('a simulated outage is retryable', async () => {
    const error = await runActivity(activities.recordPayment, [invoice, { recordPaymentFailures: 1 }]).catch(
      (err) => err
    );
    expect(error.nonRetryable).not.toBe(true);
  });
});

describe('other activities', () => {
  test('requestApproval reports who was asked', async () => {
    await expect(runActivity(activities.requestApproval, [invoice, 'director'])).resolves.toEqual({
      requestedFrom: 'director',
    });
  });

  test('revertPayment returns the payment it reverted', async () => {
    await expect(
      runActivity(activities.revertPayment, [invoice, { paymentId: 'pay-INV-1' }])
    ).resolves.toEqual({ reverted: true, paymentId: 'pay-INV-1' });
  });
});

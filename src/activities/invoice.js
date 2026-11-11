// Activities for the invoice approval process.
//
// They are simulated: no real payment system or mail server is called yet.
// What is real is how they fail, because that is what session 2 is about.

const { ApplicationFailure, Context, log } = require('@temporalio/activity');

const SUPPORTED_CURRENCIES = ['MXN', 'USD'];

/**
 * Checks that the invoice has the data needed to be processed.
 *
 * An invalid invoice will still be invalid on the next attempt, so retrying is
 * pointless. `nonRetryable: true` tells Temporal to fail immediately.
 */
async function validateInvoice(invoice) {
  const problems = [];

  if (!invoice || typeof invoice !== 'object') {
    problems.push('invoice is missing');
  } else {
    if (!invoice.id) problems.push('id is required');
    if (!invoice.supplier) problems.push('supplier is required');
    if (typeof invoice.amount !== 'number' || invoice.amount <= 0) {
      problems.push('amount must be a number greater than 0');
    }
    if (!SUPPORTED_CURRENCIES.includes(invoice.currency)) {
      problems.push(`currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
  }

  if (problems.length > 0) {
    throw ApplicationFailure.create({
      type: 'InvalidInvoiceError',
      message: `Invalid invoice: ${problems.join('; ')}`,
      nonRetryable: true,
    });
  }

  log.info('Invoice is valid', { invoiceId: invoice.id });
  return { valid: true };
}

/**
 * Records the payment in the (simulated) payment system.
 *
 * Idempotency: Temporal may run an activity more than once (for example, the
 * payment succeeded but the worker crashed before reporting it). The payment ID
 * is derived from the invoice ID, so a real payment system could detect the
 * repeated request and return the existing payment instead of paying twice.
 *
 * @param {object} invoice
 * @param {{recordPaymentFailures?: number}} [simulate] - Fail this many attempts before succeeding.
 */
async function recordPayment(invoice, simulate = {}) {
  failIfSimulated('recordPayment', simulate.recordPaymentFailures);

  const paymentId = `pay-${invoice.id}`;
  log.info('Payment recorded', { invoiceId: invoice.id, paymentId });
  return { paymentId, amount: invoice.amount, currency: invoice.currency };
}

/**
 * Sends a (simulated) notification.
 *
 * @param {object} invoice
 * @param {string} message
 * @param {{notifyFailures?: number}} [simulate] - Fail this many attempts before succeeding.
 */
async function notify(invoice, message, simulate = {}) {
  failIfSimulated('notify', simulate.notifyFailures);

  log.info('Notification sent', { invoiceId: invoice.id, message });
  return { sent: true };
}

/**
 * Throws a transient error while the current attempt number is within the
 * requested number of failures. The attempt number comes from Temporal, so the
 * behaviour is repeatable: "fail twice, then work".
 */
function failIfSimulated(activityName, failures = 0) {
  const { attempt } = Context.current().info;

  if (attempt <= failures) {
    log.warn('Simulated transient failure', { activityName, attempt, failures });
    // A plain Error is retryable by default.
    throw new Error(`${activityName}: simulated outage (attempt ${attempt})`);
  }
}

module.exports = { validateInvoice, recordPayment, notify };

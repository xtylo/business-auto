// Supplier invoice approval workflow.
//
// Session 2 scope: validate -> record payment -> notify, with automatic retries.
// Human approval, timers and compensation are added in session 3.
//
// Reminder: this file runs in the deterministic sandbox. No I/O here.

const { proxyActivities, log } = require('@temporalio/workflow');

const { validateInvoice, recordPayment, notify } = proxyActivities({
  // Timeout for ONE attempt. If the activity has not finished by then, that
  // attempt counts as failed and the retry policy below decides what happens next.
  startToCloseTimeout: '10 seconds',

  // Retry policy. Without it Temporal still retries, using its defaults:
  // unlimited attempts with exponential backoff. Stating it makes the behaviour explicit.
  retry: {
    initialInterval: '1 second', // wait before the 2nd attempt
    backoffCoefficient: 2, // then 2s, 4s, 8s...
    maximumInterval: '10 seconds', // ...but never more than this
    maximumAttempts: 5, // after 5 failed attempts the activity fails for good
  },
});

/**
 * @param {{id: string, supplier: string, amount: number, currency: string}} invoice
 * @param {object} [simulate] - Failure simulation for learning. See activities/invoice.js.
 * @returns {Promise<{invoiceId: string, status: string, paymentId: string}>}
 */
async function invoiceApproval(invoice, simulate = {}) {
  log.info('Invoice approval started', { invoiceId: invoice.id });

  // Step 1. Throws a non-retryable error when the invoice is invalid.
  // We do not catch it: the workflow fails and shows as "Failed" in the Web UI.
  await validateInvoice(invoice);

  // Step 2. May fail a few times; Temporal retries it according to the policy above.
  const payment = await recordPayment(invoice, simulate);

  // Step 3.
  await notify(invoice, `Invoice ${invoice.id} was paid (${payment.paymentId})`, simulate);

  return { invoiceId: invoice.id, status: 'PAID', paymentId: payment.paymentId };
}

module.exports = { invoiceApproval };

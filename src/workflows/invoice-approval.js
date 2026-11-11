// Supplier invoice approval workflow.
//
//   validate -> wait for a human decision (with escalation and expiry)
//            -> record payment -> post to ledger -> notify
//
// If something fails for good after the payment was recorded, the payment is reverted.
//
// Reminder: this file runs in the deterministic sandbox. No I/O here.

const {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  log,
} = require('@temporalio/workflow');

// ---- Messages this workflow understands -------------------------------------
// Signal: an external event pushed INTO a running workflow. It is recorded in
//         the history, so it is never lost and it survives worker restarts.
// Query:  a read-only question about the workflow's current state. It is not
//         recorded in the history and must not change anything.
const approveSignal = defineSignal('approve');
const rejectSignal = defineSignal('reject');
const statusQuery = defineQuery('status');

// ---- Activities --------------------------------------------------------------
const { validateInvoice, requestApproval, recordPayment, postToLedger, notify } = proxyActivities({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 5,
  },
});

// A compensation has to succeed eventually: giving up would leave money paid
// for an invoice that was never booked. So there is no maximumAttempts here.
const { revertPayment } = proxyActivities({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
  },
});

/**
 * @param {{id: string, supplier: string, amount: number, currency: string}} invoice
 * @param {object} [options]
 * @param {number} [options.approvalTimeoutSeconds] - How long each approval level may take.
 *        Seconds so it can be tried by hand; a real process would use days.
 * @param {object} [options.simulate] - Failure simulation. See activities/invoice.js.
 */
async function invoiceApproval(invoice, options = {}) {
  const { approvalTimeoutSeconds = 60, simulate = {} } = options;
  const approvalTimeoutMs = approvalTimeoutSeconds * 1000;

  // Workflow state: ordinary local variables. Temporal rebuilds them by
  // replaying the history, so there is no database table behind this.
  const state = {
    invoiceId: invoice ? invoice.id : null,
    status: 'VALIDATING',
    escalated: false,
    decision: null,
    paymentId: null,
    notified: false,
  };
  let decision;

  // Handlers are registered before the first `await`, so a signal or query
  // that arrives at any moment (even during validation) is handled.
  setHandler(statusQuery, () => ({ ...state }));

  setHandler(approveSignal, (input = {}) => {
    if (decision) return; // The first decision wins; later ones are ignored.
    decision = { approved: true, by: input.approver || 'unknown', comment: input.comment || null };
  });

  setHandler(rejectSignal, (input = {}) => {
    if (decision) return;
    decision = { approved: false, by: input.approver || 'unknown', reason: input.reason || null };
  });

  // ---- 1. Validation ---------------------------------------------------------
  await validateInvoice(invoice);

  // ---- 2. Human approval -----------------------------------------------------
  state.status = 'AWAITING_APPROVAL';
  await requestApproval(invoice, 'manager');

  // condition() suspends the workflow until the function returns true or the
  // timeout passes. While suspended, the workflow uses no worker resources:
  // it is only a record on the server. It returns false when it timed out.
  let answered = await condition(() => decision !== undefined, approvalTimeoutMs);

  if (!answered) {
    state.status = 'ESCALATED';
    state.escalated = true;
    await requestApproval(invoice, 'director');
    answered = await condition(() => decision !== undefined, approvalTimeoutMs);
  }

  if (!answered) {
    // Nobody answered. This is a business outcome, not a technical failure,
    // so the workflow completes normally with status EXPIRED.
    state.status = 'EXPIRED';
    state.notified = await notifyBestEffort(invoice, `Invoice ${invoice.id} expired without a decision`);
    return { ...state };
  }

  state.decision = decision;

  if (!decision.approved) {
    state.status = 'REJECTED';
    state.notified = await notifyBestEffort(
      invoice,
      `Invoice ${invoice.id} was rejected by ${decision.by}`
    );
    return { ...state };
  }

  // ---- 3. Payment and ledger, as a saga --------------------------------------
  // Each completed step registers how to undo itself. If a later step fails
  // for good, the registered compensations run in reverse order.
  const compensations = [];

  try {
    state.status = 'PAYING';
    const payment = await recordPayment(invoice, simulate);
    state.paymentId = payment.paymentId;
    compensations.unshift(() => revertPayment(invoice, payment));

    state.status = 'POSTING_TO_LEDGER';
    await postToLedger(invoice, payment, simulate);
  } catch (err) {
    log.warn('Process failed after approval; running compensations', {
      invoiceId: invoice.id,
      compensations: compensations.length,
    });

    state.status = 'COMPENSATING';
    for (const compensate of compensations) {
      await compensate();
    }
    state.status = compensations.length > 0 ? 'PAYMENT_REVERTED' : 'FAILED';

    // Rethrow: this is a technical failure, so the workflow ends as "Failed".
    throw err;
  }

  // ---- 4. Notification -------------------------------------------------------
  // The money is paid and booked. A notification that cannot be sent must not
  // undo that, so this step is best effort.
  state.status = 'NOTIFYING';
  state.notified = await notifyBestEffort(
    invoice,
    `Invoice ${invoice.id} was paid (${state.paymentId})`,
    simulate
  );

  state.status = 'PAID';
  return { ...state };
}

/** Sends a notification and reports whether it worked instead of throwing. */
async function notifyBestEffort(invoice, message, simulate = {}) {
  try {
    await notify(invoice, message, simulate);
    return true;
  } catch (err) {
    log.warn('Notification could not be sent', { invoiceId: invoice.id });
    return false;
  }
}

module.exports = { invoiceApproval };

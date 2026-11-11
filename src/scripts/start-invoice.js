// Starts one execution of the invoiceApproval workflow and exits.
// The workflow then waits for a human decision: see src/scripts/invoice.js.
//
// Usage:
//   npm run start:invoice -- <scenario> [approvalTimeoutSeconds]
//
// Scenarios:
//   happy       everything works after approval (default)
//   flaky       recordPayment fails twice, then succeeds
//   exhausted   recordPayment never succeeds: fails before any payment exists
//   compensate  the payment succeeds but the ledger never does: payment is reverted
//   invalid     invoice with a negative amount: fails before asking for approval
//
// approvalTimeoutSeconds: time allowed per approval level (default 60).

const { createTemporalClient } = require('../client');
const config = require('../config');

const invoiceId = `INV-${Date.now()}`;
const validInvoice = { id: invoiceId, supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

const scenarios = {
  happy: { invoice: validInvoice, simulate: {} },
  flaky: { invoice: validInvoice, simulate: { recordPaymentFailures: 2 } },
  exhausted: { invoice: validInvoice, simulate: { recordPaymentFailures: 10 } },
  compensate: { invoice: validInvoice, simulate: { postToLedgerFailures: 10 } },
  invalid: { invoice: { ...validInvoice, amount: -5 }, simulate: {} },
};

async function main() {
  const scenarioName = process.argv[2] || 'happy';
  const approvalTimeoutSeconds = Number(process.argv[3] ?? 60);
  const scenario = scenarios[scenarioName];

  if (!scenario) {
    console.error(`Unknown scenario "${scenarioName}". Use one of: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }
  if (!Number.isFinite(approvalTimeoutSeconds) || approvalTimeoutSeconds <= 0) {
    console.error('approvalTimeoutSeconds must be a number greater than 0');
    process.exit(1);
  }

  const { client, connection } = await createTemporalClient();

  try {
    const handle = await client.workflow.start('invoiceApproval', {
      taskQueue: config.taskQueue,
      // Business key as workflow ID: one workflow per invoice.
      workflowId: `invoice-${scenario.invoice.id}`,
      args: [scenario.invoice, { approvalTimeoutSeconds, simulate: scenario.simulate }],
    });

    const id = handle.workflowId;
    console.log(`Scenario "${scenarioName}" started as ${id}`);
    console.log(`Approval timeout: ${approvalTimeoutSeconds}s per level`);
    console.log(`Web UI: http://localhost:8233/namespaces/${config.namespace}/workflows/${id}`);
    console.log('');
    console.log('Next:');
    console.log(`  npm run invoice -- status ${id}`);
    console.log(`  npm run invoice -- approve ${id}`);
    console.log(`  npm run invoice -- reject ${id} "Wrong amount"`);
    console.log(`  npm run invoice -- result ${id}`);
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error('Could not start the workflow:', err.message);
  process.exit(1);
});

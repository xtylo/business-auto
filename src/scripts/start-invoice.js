// Starts one execution of the invoiceApproval workflow.
//
// Usage:
//   npm run start:invoice                 -> happy path
//   npm run start:invoice -- flaky        -> recordPayment fails twice, then succeeds
//   npm run start:invoice -- exhausted    -> recordPayment fails more times than the policy allows
//   npm run start:invoice -- invalid      -> invoice with a negative amount

const { createTemporalClient } = require('../client');
const config = require('../config');

const invoiceId = `INV-${Date.now()}`;
const validInvoice = { id: invoiceId, supplier: 'Acme Supplies', amount: 1500.5, currency: 'MXN' };

const scenarios = {
  happy: { invoice: validInvoice, simulate: {} },
  flaky: { invoice: validInvoice, simulate: { recordPaymentFailures: 2 } },
  exhausted: { invoice: validInvoice, simulate: { recordPaymentFailures: 10 } },
  invalid: { invoice: { ...validInvoice, amount: -5 }, simulate: {} },
};

async function main() {
  const scenarioName = process.argv[2] || 'happy';
  const scenario = scenarios[scenarioName];

  if (!scenario) {
    console.error(`Unknown scenario "${scenarioName}". Use one of: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  const { client, connection } = await createTemporalClient();

  try {
    const handle = await client.workflow.start('invoiceApproval', {
      taskQueue: config.taskQueue,
      // Business key as workflow ID: one workflow per invoice.
      workflowId: `invoice-${scenario.invoice.id}`,
      args: [scenario.invoice, scenario.simulate],
    });

    console.log(`Scenario "${scenarioName}" started as ${handle.workflowId}`);
    console.log(
      `Open http://localhost:8233/namespaces/${config.namespace}/workflows/${handle.workflowId}`
    );
    console.log('Waiting for the result...');

    const result = await handle.result();
    console.log('Result:', result);
  } catch (err) {
    // handle.result() rejects with WorkflowFailedError; the original error is in the cause chain.
    console.error(`Workflow failed: ${rootCause(err).message}`);
    process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

function rootCause(err) {
  let current = err;
  while (current.cause) current = current.cause;
  return current;
}

main();

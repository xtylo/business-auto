// Talks to a running invoiceApproval workflow.
//
// Usage:
//   npm run invoice -- status  <workflowId>
//   npm run invoice -- approve <workflowId> [approver] [comment]
//   npm run invoice -- reject  <workflowId> [reason] [approver]
//   npm run invoice -- result  <workflowId>      (waits until the workflow ends)

const { createTemporalClient } = require('../client');

const commands = {
  // Query: asks the workflow for its current state. Read-only.
  async status(handle) {
    console.log(await handle.query('status'));
  },

  // Signal: delivers the decision. The call returns as soon as the server has
  // stored the signal; it does not wait for the workflow to react.
  async approve(handle, [approver = 'ana.manager', comment]) {
    await handle.signal('approve', { approver, comment });
    console.log(`Approval sent as ${approver}`);
  },

  async reject(handle, [reason = 'No reason given', approver = 'ana.manager']) {
    await handle.signal('reject', { approver, reason });
    console.log(`Rejection sent as ${approver}: ${reason}`);
  },

  async result(handle) {
    console.log('Waiting for the workflow to finish...');
    try {
      console.log('Result:', await handle.result());
    } catch (err) {
      console.error(`Workflow failed: ${rootCause(err).message}`);
      process.exitCode = 1;
    }
  },
};

async function main() {
  const [commandName, workflowId, ...rest] = process.argv.slice(2);
  const command = commands[commandName];

  if (!command || !workflowId) {
    console.error('Usage: npm run invoice -- <status|approve|reject|result> <workflowId> [args]');
    process.exit(1);
  }

  const { client, connection } = await createTemporalClient();

  try {
    // A handle is only a reference by ID. Nothing is checked until it is used.
    const handle = client.workflow.getHandle(workflowId);
    await command(handle, rest);
  } finally {
    await connection.close();
  }
}

function rootCause(err) {
  let current = err;
  while (current.cause) current = current.cause;
  return current;
}

main().catch((err) => {
  console.error(`Command failed: ${rootCause(err).message}`);
  process.exit(1);
});

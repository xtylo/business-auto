// Starts one execution of the helloProcess workflow and waits for its result.
//
// Usage:
//   npm run start:hello                -> name "World", 20 second pause
//   npm run start:hello -- Ana 5       -> name "Ana", 5 second pause

const { createTemporalClient } = require('../client');
const config = require('../config');

async function main() {
  const name = process.argv[2] || 'World';
  const pauseSeconds = Number(process.argv[3] ?? 20);

  const { client, connection } = await createTemporalClient();

  try {
    // The workflow is referenced by name. This script never loads the workflow
    // code: it only asks the server to start it. A worker does the rest.
    const handle = await client.workflow.start('helloProcess', {
      taskQueue: config.taskQueue,
      // The workflow ID is yours to choose. In later sessions it will be a
      // business key (for example, the invoice number).
      workflowId: `hello-${name.toLowerCase()}-${Date.now()}`,
      args: [name, pauseSeconds],
    });

    console.log(`Started workflow ${handle.workflowId}`);
    console.log(
      `Open http://localhost:8233/namespaces/${config.namespace}/workflows/${handle.workflowId}`
    );
    console.log('Waiting for the result...');

    const result = await handle.result();
    console.log('Result:', result);
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error('Could not run the workflow:', err);
  process.exit(1);
});

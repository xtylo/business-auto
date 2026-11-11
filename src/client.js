// Temporal client: used by anything that starts or talks to workflows
// (scripts today, the Express API from session 4 onwards).

const { Client, Connection } = require('@temporalio/client');
const config = require('./config');

/**
 * Opens a connection to the Temporal server and returns a ready-to-use client.
 * The caller is responsible for closing `connection` when it is done.
 */
async function createTemporalClient() {
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  return { client, connection };
}

module.exports = { createTemporalClient };

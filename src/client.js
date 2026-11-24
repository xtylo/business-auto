// Temporal client: used by anything that starts or talks to workflows
// (scripts today, the Express API from session 4 onwards).

const { Client, Connection } = require('@temporalio/client');
const config = require('./config');
const { retry } = require('./retry');

/**
 * Returns a Temporal client and its connection. The caller closes `connection` when done.
 *
 * @param {object} [options]
 * @param {boolean} [options.lazy=false]
 *   false: connect now, retrying for a while, and fail if Temporal cannot be reached.
 *          Right for scripts, which are useless without a connection.
 *   true:  return immediately and connect on first use. Right for the API: it can
 *          start, pass its health check and answer 503 until Temporal is reachable,
 *          instead of crashing in a loop while a dependency is still starting.
 */
async function createTemporalClient({ lazy = false } = {}) {
  const connectionOptions = { address: config.temporalAddress };

  const connection = lazy
    ? Connection.lazy(connectionOptions)
    : await retry(() => Connection.connect(connectionOptions), {
        label: `Connecting to Temporal at ${config.temporalAddress}`,
      });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  return { client, connection };
}

module.exports = { createTemporalClient };

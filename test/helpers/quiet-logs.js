// Runs before each test file (see "setupFiles" in package.json).
// The Temporal SDK logs every activity and workflow event at INFO level, which
// buries the test results. Tests only need to see warnings and errors.
// Set TEST_LOG_LEVEL=INFO to get the full output back when debugging a test.

const { Runtime, DefaultLogger } = require('@temporalio/worker');

try {
  Runtime.install({ logger: new DefaultLogger(process.env.TEST_LOG_LEVEL || 'ERROR') });
} catch (err) {
  // A runtime already exists in this process; keep its logger.
}

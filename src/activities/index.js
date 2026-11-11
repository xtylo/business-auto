// Activities: the steps that touch the outside world.
//
// This is ordinary Node.js code with no sandbox restrictions: HTTP calls,
// database access, e-mail, etc. all go here. Temporal retries a failed
// activity automatically, so activities should be safe to run more than once.

const { log } = require('@temporalio/activity');

async function greet(name) {
  log.info('Running greet activity', { name });
  return `Hello, ${name}!`;
}

async function recordCompletion(name) {
  log.info('Running recordCompletion activity', { name });
  return `Process for ${name} completed at ${new Date().toISOString()}`;
}

module.exports = { greet, recordCompletion };

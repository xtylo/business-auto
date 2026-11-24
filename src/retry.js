// Retries an async operation with a fixed pause between attempts.
//
// Used when a process starts before the thing it depends on is reachable. On
// AWS the API and the worker can start a few seconds before the Temporal
// service is resolvable by DNS; without this they would crash and be restarted.

async function retry(operation, { attempts = 10, delayMs = 3000, label = 'operation' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        console.warn(`${label} failed (attempt ${attempt} of ${attempts}): ${err.message}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

module.exports = { retry };

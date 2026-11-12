// Everything the API keeps in Redis, behind three small functions.
//
// Every function "fails open": if Redis is unavailable it logs a warning and
// behaves as if nothing were stored. The API then works without the shortcut:
//   - no idempotency key  -> Temporal's workflow ID still prevents duplicates
//   - no status cache     -> every read asks Temporal directly
//
// Key layout:
//   idem:<Idempotency-Key>   -> workflow ID started by that request   (24 hours)
//   status:<workflowId>      -> JSON of the last status response      (seconds)

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function createStore(redis) {
  return {
    /**
     * Claims an idempotency key for a workflow ID.
     * @returns {Promise<{claimed: true} | {claimed: false, workflowId: string}>}
     *          claimed=false means the key was already used; workflowId is the original one.
     */
    async claimIdempotencyKey(key, workflowId) {
      try {
        // SET ... NX only writes when the key does not exist. It is atomic, so
        // two identical requests arriving together cannot both win.
        const result = await redis.set(`idem:${key}`, workflowId, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
        if (result === 'OK') return { claimed: true };

        const existing = await redis.get(`idem:${key}`);
        return existing ? { claimed: false, workflowId: existing } : { claimed: true };
      } catch (err) {
        console.warn(`Idempotency check skipped (Redis unavailable): ${err.message}`);
        return { claimed: true };
      }
    },

    /** Frees a key when the request it protected did not start anything. */
    async releaseIdempotencyKey(key) {
      try {
        await redis.del(`idem:${key}`);
      } catch (err) {
        console.warn(`Could not release idempotency key: ${err.message}`);
      }
    },

    async getCachedStatus(workflowId) {
      try {
        const raw = await redis.get(`status:${workflowId}`);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.warn(`Status cache read skipped: ${err.message}`);
        return null;
      }
    },

    async cacheStatus(workflowId, value, ttlSeconds) {
      try {
        await redis.set(`status:${workflowId}`, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        console.warn(`Status cache write skipped: ${err.message}`);
      }
    },

    /** Called after a signal, so the next read does not serve a stale status. */
    async invalidateStatus(workflowId) {
      try {
        await redis.del(`status:${workflowId}`);
      } catch (err) {
        console.warn(`Status cache invalidation skipped: ${err.message}`);
      }
    },
  };
}

module.exports = { createStore };

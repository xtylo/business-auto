// Redis connection factory.
//
// Redis plays a supporting role in this project: it makes the API cheaper and
// more forgiving, but it is never the source of truth. Temporal is. The options
// below make Redis commands fail fast instead of hanging, so the API can carry
// on without it (see src/api/store.js).

const Redis = require('ioredis');
const config = require('./config');

function createRedis() {
  let redis;

  try {
    redis = new Redis(config.redisUrl, {
      // Give up on a command after one retry instead of the default twenty.
      maxRetriesPerRequest: 1,
      // While disconnected, reject commands immediately instead of queueing them.
      enableOfflineQueue: false,
    });
  } catch (err) {
    // A malformed REDIS_URL makes the client throw here, before any connection.
    // The API is designed to work without Redis, so a bad URL must not stop it
    // from starting. Log it loudly and run with a client that always fails.
    console.error(`REDIS_URL "${config.redisUrl}" is not usable (${err.message}). Running WITHOUT Redis.`);
    return createUnavailableRedis();
  }

  // Without an 'error' listener, a lost connection would crash the process.
  redis.on('error', (err) => {
    console.warn(`Redis error: ${err.message}`);
  });

  return redis;
}

/** Stand-in used when no real client could be created: every command rejects. */
function createUnavailableRedis() {
  const unavailable = async () => {
    throw new Error('Redis is not configured');
  };
  return { set: unavailable, get: unavailable, del: unavailable, disconnect() {} };
}

module.exports = { createRedis };

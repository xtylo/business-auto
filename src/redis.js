// Redis connection factory.
//
// Redis plays a supporting role in this project: it makes the API cheaper and
// more forgiving, but it is never the source of truth. Temporal is. The options
// below make Redis commands fail fast instead of hanging, so the API can carry
// on without it (see src/api/store.js).

const Redis = require('ioredis');
const config = require('./config');

function createRedis() {
  const redis = new Redis(config.redisUrl, {
    // Give up on a command after one retry instead of the default twenty.
    maxRetriesPerRequest: 1,
    // While disconnected, reject commands immediately instead of queueing them.
    enableOfflineQueue: false,
  });

  // Without an 'error' listener, a lost connection would crash the process.
  redis.on('error', (err) => {
    console.warn(`Redis error: ${err.message}`);
  });

  return redis;
}

module.exports = { createRedis };

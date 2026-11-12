// In-memory stand-in for the few Redis commands the API uses.
// It lets API tests run with no Redis server, and lets a test simulate an outage.

function createFakeRedis() {
  const data = new Map();
  let down = false;

  const failIfDown = () => {
    if (down) throw new Error('Connection is closed.');
  };

  return {
    // Test controls
    data,
    goDown() {
      down = true;
    },

    // SET key value EX seconds [NX]
    async set(key, value, ...args) {
      failIfDown();
      if (args.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async get(key) {
      failIfDown();
      return data.has(key) ? data.get(key) : null;
    },
    async del(key) {
      failIfDown();
      return data.delete(key) ? 1 : 0;
    },
  };
}

module.exports = { createFakeRedis };

const { createClient } = require('redis');

const PREFIX = 'faultline:auth:';

/** Revokes every live browser/API session for a user across all API instances. */
async function revokeAllSessions(redisUrl, userId) {
  if (!redisUrl) throw new Error('Missing REDIS_URL. Run: npm run setup');
  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  await redis.connect();
  try {
    const userKey = `${PREFIX}user-sessions:${userId}`;
    const ids = await redis.sMembers(userKey);
    const transaction = redis.multi();
    for (const id of ids) transaction.del(`${PREFIX}session:${id}`);
    transaction.del(userKey);
    await transaction.exec();
  } finally {
    if (redis.isOpen) await redis.quit();
  }
}

module.exports = { revokeAllSessions };

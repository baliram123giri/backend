import { redis, clearMemoryCache } from '../../lib/redis.js';

export default async function adminFlushCacheRoutes(fastify, options) {
  fastify.post('/flush-cache', async (request, reply) => {
    try {
      // Always clear L1 memory cache
      clearMemoryCache();
      
      if (redis && redis.status === 'ready') {
        await redis.flushdb();
        return reply.send({ success: true, message: "L1 Memory and L2 Redis cache flushed successfully" });
      } else {
        return reply.status(503).send({ success: false, error: "L1 Memory cleared, but Redis is not connected" });
      }
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ success: false, error: "Failed to flush cache" });
    }
  });
}

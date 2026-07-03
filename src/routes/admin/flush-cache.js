import { redis, clearMemoryCache } from '../../lib/redis.js';

export default async function adminFlushCacheRoutes(fastify, options) {
  fastify.post('/flush-cache', async (request, reply) => {
    try {
      // 1. Always clear L1 memory cache
      clearMemoryCache();
      
      // 2. Clear L2 Redis Cache
      let redisFlushed = false;
      if (redis && redis.status === 'ready') {
        await redis.flushdb();
        redisFlushed = true;
      }
      
      // 3. Clear Cloudflare CDN Edge Cache
      let cloudflareFlushed = false;
      let cloudflareError = null;
      if (process.env.CLOUDFLARE_ZONE_ID && process.env.CLOUDFLARE_API_TOKEN) {
        try {
          const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
            },
            body: JSON.stringify({ purge_everything: true })
          });
          const cfData = await cfResponse.json();
          if (cfData.success) {
            cloudflareFlushed = true;
          } else {
            cloudflareError = cfData.errors;
          }
        } catch (e) {
          cloudflareError = e.message;
        }
      }

      return reply.send({ 
        success: true, 
        message: "Cache flush operation completed",
        details: {
          memoryCache: true,
          redis: redisFlushed,
          cloudflare: cloudflareFlushed,
          cloudflareError: cloudflareError
        }
      });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ success: false, error: "Failed to flush cache" });
    }
  });
}

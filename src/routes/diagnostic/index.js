import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

export default async function diagnosticRoutes(fastify, options) {
  const handleDiagnostic = async (request, reply) => {
    let dbStatus = 'disconnected';
    let dbLatencyMs = null;
    try {
      const dbStart = Date.now();
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB Timeout')), 2000)),
      ]);
      dbStatus = 'connected';
      dbLatencyMs = Date.now() - dbStart;
    } catch (e) {
      dbStatus = `error: ${e.message}`;
    }

    const redisStatus = redis && redis.status === 'ready' ? 'connected' : (redis?.status || 'disconnected');
    const isHealthy = dbStatus === 'connected';

    if (!isHealthy) {
      reply.status(503);
    }

    return {
      status: isHealthy ? 'ok' : 'degraded',
      database: dbStatus,
      databaseLatencyMs: dbLatencyMs,
      redis: redisStatus,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  };

  const handleHealth = async (request, reply) => {
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB Timeout')), 2000)),
      ]);
      return { status: 'ok', uptime: Math.round(process.uptime()) };
    } catch {
      reply.status(503);
      return { status: 'unhealthy' };
    }
  };

  fastify.get('/diagnostic', handleDiagnostic);
  fastify.get('/api/diagnostic', handleDiagnostic);

  fastify.get('/health', handleHealth);
  fastify.get('/api/health', handleHealth);
}

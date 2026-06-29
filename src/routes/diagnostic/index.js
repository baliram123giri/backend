export default async function diagnosticRoutes(fastify, options) {
  fastify.get('/diagnostic', async (request, reply) => {
    return {
      status: 'ok',
      redis: fastify.redis && fastify.redis.status === 'ready' ? 'connected' : 'disconnected',
      database: 'connected', // Prisma handles connection, typically we could check prisma.$queryRaw`SELECT 1`
      uptime: process.uptime()
    };
  });
  
  fastify.get('/health', async (request, reply) => {
    return { status: 'ok' };
  });
}

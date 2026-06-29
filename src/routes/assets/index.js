import { prisma } from '../../lib/prisma.js';
import { getCachedOrFetch } from '../../lib/redis.js';
import { GRADIENT_PRESETS } from '../../../helpers.js';
export default async function routes(app, options) {
// 1. GET /api/stickers
// -------------------------------------------------------------
// -------------------------------------------------------------
app.get('/api/gradients', async (request, reply) => {
  reply.header('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=60');
  return GRADIENT_PRESETS;
});

// -------------------------------------------------------------
// 3.1 GET /api/proxy-logo
// -------------------------------------------------------------
app.get('/api/backgrounds', async (request, reply) => {
  try {
    const limit = parseInt(request.query.limit || '100', 10);
    const cursor = request.query.cursor || undefined;

    const cacheKey = `backgrounds:limit=${limit}:cursor=${cursor || ''}`;

    const data = await getCachedOrFetch(cacheKey, 60, async () => {
      const backgrounds = await prisma.background.findMany({
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: 'desc' },
      });

      const nextCursor = backgrounds.length === limit ? backgrounds[backgrounds.length - 1].id : null;
      return { success: true, backgrounds, nextCursor };
    });

    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=30');
    return data;
  } catch (error) {
    app.log.error('Fetch public backgrounds error:', error);
    reply.status(500).send({ error: 'Internal server error' });
  }
});

// -------------------------------------------------------------
// 5. GET /api/hero-slides
// -------------------------------------------------------------
app.get('/api/hero-slides', async (request, reply) => {
  try {
    const cacheKey = 'hero-slides';
    const data = await getCachedOrFetch(cacheKey, 300, async () => {
      const slides = await prisma.heroSlide.findMany({
        where: { active: true },
        orderBy: { order: 'asc' },
      });
      return { slides };
    });
    return data;
  } catch (error) {
    app.log.error('Fetch hero slides database error:', error);
    return { slides: [], error: error.message };
  }
});

}

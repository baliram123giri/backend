import { prisma } from '../../lib/prisma.js';
import { getCachedOrFetch } from '../../lib/redis.js';

export default async function routes(app, options) {
// 1. GET /api/stickers
// -------------------------------------------------------------
// -------------------------------------------------------------
app.get('/api/stickers', async (request, reply) => {
  try {
    const limit = parseInt(request.query.limit || '10', 10);
    const cursor = request.query.cursor || undefined;
    const type = request.query.type;
    const religion = request.query.religion;

    const cacheKey = `stickers:type=${type || ''}:religion=${religion || ''}:limit=${limit}:cursor=${cursor || ''}`;

    const data = await getCachedOrFetch(cacheKey, 60, async () => {
      const whereClause = {};
      if (type) whereClause.type = type;
      if (religion && religion !== 'All') whereClause.religion = religion;

      const stickers = await prisma.sticker.findMany({
        where: whereClause,
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: 'desc' },
      });

      const nextCursor = stickers.length === limit ? stickers[stickers.length - 1].id : null;
      return { success: true, stickers, nextCursor };
    });

    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=30');
    return data;
  } catch (error) {
    app.log.error('Fetch public stickers error:', error);
    reply.status(500).send({ error: 'Internal server error' });
  }
});

}

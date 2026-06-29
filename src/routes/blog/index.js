import { prisma } from '../../lib/prisma.js';
import { getCachedOrFetch } from '../../lib/redis.js';

export default async function routes(app, options) {
  // 1. GET /api/blog
  app.get('/api/blog', async (request, reply) => {
    try {
      const cacheKey = 'blog:posts:all';
      const data = await getCachedOrFetch(cacheKey, 60, async () => {
        const posts = await prisma.blogPost.findMany({
          orderBy: { createdAt: 'desc' },
        });
        return { success: true, posts };
      });
      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=30');
      return data;
    } catch (error) {
      app.log.error('Fetch blog posts error:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // 2. GET /api/blog/:slug
  app.get('/api/blog/:slug', async (request, reply) => {
    try {
      const { slug } = request.params;
      const cacheKey = `blog:post:slug=${slug}`;
      const data = await getCachedOrFetch(cacheKey, 60, async () => {
        const post = await prisma.blogPost.findUnique({
          where: { slug },
        });
        return { success: true, post };
      });
      if (!data.post) {
        return reply.status(404).send({ error: 'Blog post not found' });
      }
      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=30');
      return data;
    } catch (error) {
      app.log.error('Fetch blog post error:', error);
      reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

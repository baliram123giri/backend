import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

const CACHE_KEY = "admin:feedback";
const SETTINGS_CACHE_KEY = "admin:review-settings";

export default async function adminFeedbackRoutes(app, options) {
  // GET all feedback
  app.get('/feedback', async (request, reply) => {
    try {
      const feedback = await getCachedOrFetch(CACHE_KEY, 300, async () => {
        return prisma.feedback.findMany({
          orderBy: { createdAt: 'desc' }
        });
      });
      return reply.send({ success: true, feedback });
    } catch (error) {
      app.log.error('GET Feedback Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch feedback' });
    }
  });

  // DELETE feedback
  app.delete('/feedback', async (request, reply) => {
    try {
      const { id, ids } = request.body;
      const targetIds = ids || (id ? [id] : null);

      if (!targetIds || !Array.isArray(targetIds) || targetIds.length === 0) {
        return reply.status(400).send({ error: 'ID or IDs are required' });
      }

      await prisma.feedback.deleteMany({
        where: {
          id: { in: targetIds }
        }
      });

      if (redis && redis.status === 'ready') {
        await redis.del(CACHE_KEY);
        await redis.del('admin:dashboard-stats');
      }

      return reply.send({ success: true, message: `${targetIds.length} feedback items deleted successfully` });
    } catch (error) {
      app.log.error('Delete Feedback Error:', error);
      return reply.status(500).send({ error: 'Failed to delete feedback' });
    }
  });

  // GET review-settings
  app.get('/review-settings', async (request, reply) => {
    try {
      const settings = await getCachedOrFetch(SETTINGS_CACHE_KEY, 3600, async () => {
        return prisma.reviewSettings.upsert({
          where: { id: "global" },
          update: {},
          create: {
            id: "global",
            googleEnabled: true,
            googleRating: 4.9,
            googleCount: 524,
            googleUrl: "https://share.google/T4eEjxMJkqDKaFWGN",
            trustpilotEnabled: true,
            trustpilotRating: 4.8,
            trustpilotCount: 320,
            trustpilotUrl: "https://www.trustpilot.com/review/biodata99.com",
          }
        });
      });

      return reply.send({ success: true, settings });
    } catch (error) {
      app.log.error('GET Review Settings Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch review settings' });
    }
  });

  // POST review-settings
  app.post('/review-settings', async (request, reply) => {
    try {
      const {
        googleEnabled,
        googleRating,
        googleCount,
        googleUrl,
        trustpilotEnabled,
        trustpilotRating,
        trustpilotCount,
        trustpilotUrl,
      } = request.body;

      const settings = await prisma.reviewSettings.upsert({
        where: { id: "global" },
        update: {
          googleEnabled: googleEnabled ?? true,
          googleRating: parseFloat(googleRating),
          googleCount: parseInt(googleCount),
          googleUrl,
          trustpilotEnabled: trustpilotEnabled ?? true,
          trustpilotRating: parseFloat(trustpilotRating),
          trustpilotCount: parseInt(trustpilotCount),
          trustpilotUrl,
        },
        create: {
          id: "global",
          googleEnabled: googleEnabled ?? true,
          googleRating: parseFloat(googleRating),
          googleCount: parseInt(googleCount),
          googleUrl,
          trustpilotEnabled: trustpilotEnabled ?? true,
          trustpilotRating: parseFloat(trustpilotRating),
          trustpilotCount: parseInt(trustpilotCount),
          trustpilotUrl,
        }
      });

      if (redis && redis.status === 'ready') {
        await redis.del(SETTINGS_CACHE_KEY);
        await redis.del('public:footer-reviews'); // Invalidate public cache if present
      }

      return reply.send({ success: true, settings });
    } catch (error) {
      app.log.error('POST Review Settings Error:', error);
      return reply.status(500).send({ error: 'Failed to update review settings' });
    }
  });
}

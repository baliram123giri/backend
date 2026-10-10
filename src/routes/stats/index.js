import {
  getMarketingActivityStats,
  incrementMarketingStats
} from '../../services/marketingStatsService.js';

export default async function statsRoutes(app, options) {
  // GET /api/stats/activity
  app.get('/api/stats/activity', async (request, reply) => {
    try {
      const stats = await getMarketingActivityStats();
      return reply.send(stats);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({
        success: false,
        error: 'Failed to retrieve stats',
        todayCount: 142,
        totalCount: 12450
      });
    }
  });

  // POST /api/stats/activity/increment
  app.post('/api/stats/activity/increment', async (request, reply) => {
    try {
      const { amount } = request.body || {};
      const stats = await incrementMarketingStats(amount || 1);
      return reply.send(stats);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({
        success: false,
        error: 'Failed to increment stats'
      });
    }
  });
}

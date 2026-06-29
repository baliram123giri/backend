import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

const CACHE_KEY = "admin:dashboard-stats";

export default async function dashboardRoutes(app, options) {
  app.get('/dashboard-stats', async (request, reply) => {
    try {
      const bypassCache = request.query.bypass === 'true';
      if (bypassCache && redis && redis.status === 'ready') {
        await redis.del(CACHE_KEY);
      }

      // Cached overall aggregates (parallelized for maximum database performance)
      const stats = await getCachedOrFetch(CACHE_KEY, 300, async () => {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Prepare the 7-day traffic queries in parallel
        const trafficPromises = [];
        for (let i = 6; i >= 0; i--) {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          startOfDay.setDate(startOfDay.getDate() - i);

          const endOfDay = new Date();
          endOfDay.setHours(23, 59, 59, 999);
          endOfDay.setDate(endOfDay.getDate() - i);

          const dayLabel = startOfDay.toLocaleDateString(undefined, { weekday: "short" });

          trafficPromises.push(
            prisma.downloadLog.count({
              where: {
                createdAt: {
                  gte: startOfDay,
                  lte: endOfDay,
                },
              },
            }).then(count => ({ day: dayLabel, count }))
          );
        }

        const [
          totalUsers,
          newUsersToday,
          totalDownloads,
          downloadsThisWeek,
          paidOrders,
          paidOrdersToday,
          templates,
          recentDownloadsRaw,
          groupedPopularity,
          ...dailyTraffic
        ] = await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
          prisma.downloadLog.count(),
          prisma.downloadLog.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
          prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
          prisma.order.aggregate({ where: { status: "paid", createdAt: { gte: oneDayAgo } }, _sum: { amount: true } }),
          prisma.template.findMany({ select: { id: true, name: true } }),
          prisma.downloadLog.findMany({ take: 5, orderBy: { createdAt: "desc" } }),
          prisma.downloadLog.groupBy({ by: ["templateId"], _count: { templateId: true } }),
          ...trafficPromises
        ]);

        const totalRevenue = paidOrders._sum.amount || 0;
        const revenueToday = paidOrdersToday._sum.amount || 0;

        const recentDownloads = recentDownloadsRaw.map(log => {
          const template = templates.find(t => t.id === log.templateId);
          return {
            ...log,
            templateName: template ? template.name : "Default Theme"
          };
        });

        // Template popularity mapping
        let templatePopularity = groupedPopularity.map((item) => {
          const template = templates.find((t) => t.id === item.templateId);
          return {
            name: template ? template.name : "Default Theme",
            count: item._count.templateId,
          };
        });

        templatePopularity.sort((a, b) => b.count - a.count);

        const totalLogCount = templatePopularity.reduce((sum, item) => sum + item.count, 0) || 1;
        templatePopularity = templatePopularity.map((item) => ({
          ...item,
          percentage: Number(((item.count / totalLogCount) * 100).toFixed(1)),
        }));

        if (templatePopularity.length === 0) {
          templatePopularity = [
            { name: "Default Theme", count: 0, percentage: 100 },
          ];
        }

        return {
          totalUsers,
          newUsersToday,
          totalDownloads,
          downloadsThisWeek,
          totalRevenue,
          revenueToday,
          recentDownloads,
          templatePopularity,
          dailyTraffic,
        };
      });

      return reply.send({
        ...stats,
        liveMetrics: null,
        systemMetrics: null
      });
    } catch (error) {
      app.log.error("Dashboard stats error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

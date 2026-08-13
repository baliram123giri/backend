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

        const [
          totalUsers,
          newUsersToday,
          totalPaidOrders,
          paidOrdersThisWeek,
          paidOrders,
          paidOrdersToday,
          templates,
          recentOrdersRaw,
          groupedPopularity,
          totalAffiliates,
          newAffiliatesToday,
          pendingAffiliateRequests,
          pendingWithdrawalRequests,
          pendingCommissions,
          pastWeekOrders,
        ] = await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
          prisma.order.count({ where: { status: "paid" } }),
          prisma.order.count({ where: { status: "paid", createdAt: { gte: sevenDaysAgo } } }),
          prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
          prisma.order.aggregate({ where: { status: "paid", createdAt: { gte: oneDayAgo } }, _sum: { amount: true } }),
          prisma.template.findMany({ select: { id: true, name: true } }),
          prisma.order.findMany({
            take: 5,
            orderBy: { createdAt: "desc" },
            include: {
              downloadLogs: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: { location: true, name: true }
              }
            }
          }),
          prisma.order.groupBy({ by: ["templateId"], where: { status: "paid" }, _count: { templateId: true } }),
          prisma.affiliate.count(),
          prisma.affiliate.count({ where: { createdAt: { gte: oneDayAgo } } }),
          prisma.affiliate.count({ where: { status: 'pending' } }),
          prisma.withdrawal.count({ where: { status: 'pending' } }),
          prisma.commission.count({ where: { status: 'pending' } }),
          prisma.order.findMany({
            where: { status: "paid", createdAt: { gte: sevenDaysAgo } },
            select: { createdAt: true }
          }),
        ]);

        const totalDownloads = totalPaidOrders;
        const downloadsThisWeek = paidOrdersThisWeek;

        // Calculate 7-day traffic in memory efficiently
        const dailyTraffic = [];
        for (let i = 6; i >= 0; i--) {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          startOfDay.setDate(startOfDay.getDate() - i);

          const endOfDay = new Date();
          endOfDay.setHours(23, 59, 59, 999);
          endOfDay.setDate(endOfDay.getDate() - i);

          const dayLabel = startOfDay.toLocaleDateString(undefined, { weekday: "short" });
          const count = pastWeekOrders.filter(order => {
            const time = new Date(order.createdAt).getTime();
            return time >= startOfDay.getTime() && time <= endOfDay.getTime();
          }).length;

          dailyTraffic.push({ day: dayLabel, count });
        }

        const totalRevenue = Number((paidOrders._sum.amount || 0).toFixed(2));
        const revenueToday = Number((paidOrdersToday._sum.amount || 0).toFixed(2));

        const recentTransactions = recentOrdersRaw.map(order => {
          const template = templates.find(t => t.id === order.templateId);
          const dlLocation = order.downloadLogs?.[0]?.location;
          const dlName = order.downloadLogs?.[0]?.name;

          return {
            id: order.id,
            name: order.customerName || dlName || "Matrimonial Biodata",
            location: dlLocation || order.customerPhone || order.customerEmail || "Direct Checkout",
            biodataLocation: dlLocation || null,
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            customerPhone: order.customerPhone,
            format: (order.format || 'PDF').toUpperCase(),
            amount: Number((order.amount || 0).toFixed(2)),
            currency: order.currency || "INR",
            status: order.status || "paid",
            downloadStatus: order.downloadStatus || "pending",
            templateId: order.templateId,
            templateName: template ? template.name : "Premium Theme",
            razorpayOrderId: order.razorpayOrderId,
            createdAt: order.createdAt,
          };
        });

        // Template popularity mapping
        let templatePopularity = groupedPopularity.map((item) => {
          const template = templates.find((t) => t.id === item.templateId);
          return {
            name: template ? template.name : "Premium Theme",
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
          recentTransactions,
          recentDownloads: recentTransactions,
          templatePopularity,
          dailyTraffic,
          totalAffiliates,
          newAffiliatesToday,
          pendingAffiliateRequests,
          pendingWithdrawalRequests,
          pendingCommissions,
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

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
          feedbackCount,
          feedbackCountToday,
          feedbackCountThisWeek,
          feedbackAvg,
          feedbackRatingGroup,
          recentFeedbackList,
          reviewSettings,
          totalFreeDownloads,
          freeDownloadsToday,
          freeDownloadsThisWeek,
          pastWeekFreeDownloads,
          recentDownloadLogsRaw,
        ] = await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
          prisma.order.count({ where: { status: "paid" } }),
          prisma.order.count({ where: { status: "paid", createdAt: { gte: sevenDaysAgo } } }),
          prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
          prisma.order.aggregate({ where: { status: "paid", createdAt: { gte: oneDayAgo } }, _sum: { amount: true } }),
          prisma.template.findMany({ select: { id: true, name: true } }),
          prisma.order.findMany({
            take: 10,
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
          prisma.feedback.count(),
          prisma.feedback.count({ where: { createdAt: { gte: oneDayAgo } } }),
          prisma.feedback.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
          prisma.feedback.aggregate({ _avg: { rating: true } }),
          prisma.feedback.groupBy({ by: ["rating"], _count: { rating: true } }),
          prisma.feedback.findMany({
            take: 6,
            orderBy: { createdAt: "desc" }
          }),
          prisma.reviewSettings.findUnique({ where: { id: "global" } }),
          prisma.downloadLog.count({ where: { orderId: null } }),
          prisma.downloadLog.count({ where: { orderId: null, createdAt: { gte: oneDayAgo } } }),
          prisma.downloadLog.count({ where: { orderId: null, createdAt: { gte: sevenDaysAgo } } }),
          prisma.downloadLog.findMany({
            where: { orderId: null, createdAt: { gte: sevenDaysAgo } },
            select: { createdAt: true }
          }),
          prisma.downloadLog.findMany({
            take: 10,
            orderBy: { createdAt: "desc" },
            include: {
              order: true
            }
          })
        ]);

        const totalPaidDownloads = totalPaidOrders;
        const totalDownloads = totalPaidOrders + totalFreeDownloads;
        const downloadsThisWeek = paidOrdersThisWeek + freeDownloadsThisWeek;
        const downloadsToday = (paidOrdersToday._sum.amount ? 1 : 0) + freeDownloadsToday;

        // Calculate 7-day traffic in memory efficiently (combining paid and free generated documents)
        const dailyTraffic = [];
        for (let i = 6; i >= 0; i--) {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          startOfDay.setDate(startOfDay.getDate() - i);

          const endOfDay = new Date();
          endOfDay.setHours(23, 59, 59, 999);
          endOfDay.setDate(endOfDay.getDate() - i);

          const dayLabel = startOfDay.toLocaleDateString(undefined, { weekday: "short" });
          const orderCount = pastWeekOrders.filter(order => {
            const time = new Date(order.createdAt).getTime();
            return time >= startOfDay.getTime() && time <= endOfDay.getTime();
          }).length;

          const freeCount = pastWeekFreeDownloads.filter(dl => {
            const time = new Date(dl.createdAt).getTime();
            return time >= startOfDay.getTime() && time <= endOfDay.getTime();
          }).length;

          dailyTraffic.push({ day: dayLabel, count: orderCount + freeCount });
        }

        const totalRevenue = Number((paidOrders._sum.amount || 0).toFixed(2));
        const revenueToday = Number((paidOrdersToday._sum.amount || 0).toFixed(2));

        // Format recent paid orders
        const formattedOrders = recentOrdersRaw.map(order => {
          const template = templates.find(t => t.id === order.templateId);
          const dlLocation = order.downloadLogs?.[0]?.location;
          const dlName = order.downloadLogs?.[0]?.name;

          return {
            id: order.id,
            orderId: order.razorpayOrderId,
            name: order.customerName || dlName || "Matrimonial Biodata",
            location: dlLocation || order.customerPhone || order.customerEmail || "Direct Checkout",
            biodataLocation: dlLocation || null,
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            customerPhone: order.customerPhone,
            format: (order.format || 'PDF').toUpperCase(),
            amount: Number((order.amount || 0).toFixed(2)),
            currency: order.currency || "INR",
            isFree: false,
            paymentType: "PAID",
            status: (order.status || "PAID").toUpperCase(),
            downloadStatus: order.downloadStatus || "pending",
            templateId: order.templateId,
            templateName: template ? template.name : "Premium Theme",
            razorpayOrderId: order.razorpayOrderId,
            createdAt: order.createdAt,
          };
        });

        // Format recent free downloads (exclude logs that are already tied to paid orders to avoid duplication)
        const formattedFreeLogs = recentDownloadLogsRaw
          .filter(log => !log.order || log.order.status !== 'paid')
          .map(log => {
            const template = templates.find(t => t.id === log.templateId);
            return {
              id: log.id,
              orderId: null,
              name: log.name || "Matrimonial Biodata",
              location: log.location || "Direct Download",
              biodataLocation: log.location || null,
              customerName: log.name,
              customerEmail: null,
              customerPhone: null,
              format: (log.format || 'PDF').toUpperCase(),
              amount: 0,
              currency: "INR",
              isFree: true,
              paymentType: "FREE",
              status: "FREE",
              downloadStatus: log.errorMsg ? "failed" : "success",
              templateId: log.templateId,
              templateName: template ? template.name : "Standard Theme",
              razorpayOrderId: null,
              createdAt: log.createdAt,
            };
          });

        // Combine and sort by createdAt desc
        const recentTransactions = [...formattedOrders, ...formattedFreeLogs]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

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

        // Review and satisfaction statistics
        const totalReviews = feedbackCount;
        const reviewsThisWeek = feedbackCountThisWeek;
        const reviewsToday = feedbackCountToday;
        const averageRating = feedbackAvg._avg?.rating ? Number(feedbackAvg._avg.rating.toFixed(1)) : 5.0;

        const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        feedbackRatingGroup.forEach(g => {
          if (ratingCounts[g.rating] !== undefined) {
            ratingCounts[g.rating] = g._count.rating;
          }
        });

        const positiveCount = (ratingCounts[5] || 0) + (ratingCounts[4] || 0);
        const criticalReviewsCount = (ratingCounts[1] || 0) + (ratingCounts[2] || 0);
        const positivePercentage = totalReviews > 0 ? Math.round((positiveCount / totalReviews) * 100) : 100;

        const distribution = [5, 4, 3, 2, 1].map(stars => ({
          stars,
          count: ratingCounts[stars] || 0,
          percentage: totalReviews > 0 ? Number((( (ratingCounts[stars] || 0) / totalReviews) * 100).toFixed(1)) : 0,
        }));

        const reviewStats = {
          totalReviews,
          reviewsThisWeek,
          reviewsToday,
          averageRating,
          positivePercentage,
          positiveCount,
          criticalReviewsCount,
          distribution,
          ratingCounts,
          recentReviews: recentFeedbackList.map(item => ({
            id: item.id,
            name: item.name,
            rating: item.rating,
            comment: item.comment,
            createdAt: item.createdAt,
          })),
          reviewSettings: reviewSettings || {
            googleEnabled: true,
            googleRating: 4.9,
            googleCount: 524,
            googleUrl: "https://share.google/T4eEjxMJkqDKaFWGN",
            trustpilotEnabled: true,
            trustpilotRating: 4.8,
            trustpilotCount: 320,
            trustpilotUrl: "https://www.trustpilot.com/review/biodata99.com"
          }
        };

        return {
          totalUsers,
          newUsersToday,
          totalDownloads,
          totalPaidDownloads,
          totalFreeDownloads,
          downloadsThisWeek,
          paidDownloadsThisWeek,
          freeDownloadsThisWeek,
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
          reviewStats,
        };
      });

      return reply.send({
        ...stats,
        liveMetrics: {
          criticalReviewsCount: stats.reviewStats?.criticalReviewsCount || 0
        },
        systemMetrics: null
      });
    } catch (error) {
      app.log.error("Dashboard stats error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

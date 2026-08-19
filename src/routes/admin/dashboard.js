import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

const CACHE_KEY = "admin:dashboard-stats";

export default async function dashboardRoutes(app, options) {
  app.get('/dashboard-stats', async (request, reply) => {
    try {
      const bypassCache = request.query.bypass === 'true';
      if (bypassCache && redis && redis.status === 'ready') {
        await redis.del(CACHE_KEY).catch(() => {});
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
          totalFailedDownloadsCount,
          failedDownloadsTodayCount,
          totalFailedOrdersCount,
          failedOrdersTodayCount,
          recentFailedOrdersRaw,
          recentFailedLogsRaw,
        ] = await Promise.all([
          prisma.user.count().catch(() => 0),
          prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.order.count({ where: { status: "paid" } }).catch(() => 0),
          prisma.order.count({ where: { status: "paid", createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
          prisma.order.aggregate({ where: { status: "paid" }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
          prisma.order.aggregate({ where: { status: "paid", createdAt: { gte: oneDayAgo } }, _sum: { amount: true } }).catch(() => ({ _sum: { amount: 0 } })),
          prisma.template.findMany({ select: { id: true, name: true } }).catch(() => []),
          prisma.order.findMany({
            take: 10,
            orderBy: { createdAt: "desc" },
            include: {
              downloadLogs: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: { location: true, name: true, errorMsg: true }
              }
            }
          }).catch(() => []),
          prisma.order.groupBy({ by: ["templateId"], where: { status: "paid" }, _count: { templateId: true } }).catch(() => []),
          prisma.affiliate.count().catch(() => 0),
          prisma.affiliate.count({ where: { createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.affiliate.count({ where: { status: 'pending' } }).catch(() => 0),
          prisma.withdrawal.count({ where: { status: 'pending' } }).catch(() => 0),
          prisma.commission.count({ where: { status: 'pending' } }).catch(() => 0),
          prisma.order.findMany({
            where: { status: "paid", createdAt: { gte: sevenDaysAgo } },
            select: { createdAt: true }
          }).catch(() => []),
          prisma.feedback.count().catch(() => 0),
          prisma.feedback.count({ where: { createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.feedback.count({ where: { createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
          prisma.feedback.aggregate({ _avg: { rating: true } }).catch(() => ({ _avg: { rating: 5.0 } })),
          prisma.feedback.groupBy({ by: ["rating"], _count: { rating: true } }).catch(() => []),
          prisma.feedback.findMany({
            take: 5,
            orderBy: { createdAt: "desc" }
          }).catch(() => []),
          prisma.reviewSettings.findUnique({ where: { id: "global" } }).catch(() => null),
          prisma.downloadLog.count({ where: { orderId: null } }).catch(() => 0),
          prisma.downloadLog.count({ where: { orderId: null, createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.downloadLog.count({ where: { orderId: null, createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
          prisma.downloadLog.findMany({
            where: { orderId: null, createdAt: { gte: sevenDaysAgo } },
            select: { createdAt: true }
          }).catch(() => []),
          prisma.downloadLog.findMany({
            take: 10,
            orderBy: { createdAt: "desc" }
          }).catch(() => []),
          prisma.downloadLog.count({ where: { errorMsg: { not: null } } }).catch(() => 0),
          prisma.downloadLog.count({ where: { errorMsg: { not: null }, createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.order.count({ where: { OR: [{ status: "failed" }, { downloadStatus: "failed" }] } }).catch(() => 0),
          prisma.order.count({ where: { OR: [{ status: "failed" }, { downloadStatus: "failed" }], createdAt: { gte: oneDayAgo } } }).catch(() => 0),
          prisma.order.findMany({
            where: { OR: [{ status: "failed" }, { downloadStatus: "failed" }] },
            take: 10,
            orderBy: { createdAt: "desc" },
            include: {
              downloadLogs: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: { location: true, name: true, errorMsg: true }
              }
            }
          }).catch(() => []),
          prisma.downloadLog.findMany({
            where: { errorMsg: { not: null }, orderId: null },
            take: 10,
            orderBy: { createdAt: "desc" }
          }).catch(() => [])
        ]);

        const totalPaidDownloads = totalPaidOrders || 0;
        const totalDownloads = (totalPaidOrders || 0) + (totalFreeDownloads || 0);
        const downloadsThisWeek = (paidOrdersThisWeek || 0) + (freeDownloadsThisWeek || 0);

        // Safe revenue calculations
        const totalRevenue = Number(((paidOrders?._sum?.amount ?? 0)).toFixed(2));
        const revenueToday = Number(((paidOrdersToday?._sum?.amount ?? 0)).toFixed(2));

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
          const orderCount = (pastWeekOrders || []).filter(order => {
            if (!order?.createdAt) return false;
            const time = new Date(order.createdAt).getTime();
            return time >= startOfDay.getTime() && time <= endOfDay.getTime();
          }).length;

          const freeCount = (pastWeekFreeDownloads || []).filter(dl => {
            if (!dl?.createdAt) return false;
            const time = new Date(dl.createdAt).getTime();
            return time >= startOfDay.getTime() && time <= endOfDay.getTime();
          }).length;

          dailyTraffic.push({ day: dayLabel, count: orderCount + freeCount });
        }

        const getDisplayName = (name, orderId, id, isFree) => {
          if (name && typeof name === 'string' && name.trim() && name.trim() !== 'Matrimonial Biodata' && name.trim() !== 'Unnamed') {
            return name.trim();
          }
          if (orderId) {
            const clean = String(orderId).replace(/^order_/, '').slice(0, 6).toUpperCase();
            return `Guest User #${clean}`;
          }
          if (id) {
            const clean = String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
            return `Guest User #${clean}`;
          }
          return isFree ? 'Guest User (Free)' : 'Guest User';
        };

        // Format recent paid orders
        const templatesList = Array.isArray(templates) ? templates : [];
        const formattedOrders = (recentOrdersRaw || []).map(order => {
          const template = templatesList.find(t => t.id === order.templateId);
          const dlLocation = order.downloadLogs?.[0]?.location;
          const dlName = order.downloadLogs?.[0]?.name;
          const resolvedDisplayName = getDisplayName(order.customerName || dlName, order.razorpayOrderId, order.id, false);

          return {
            id: order.id,
            orderId: order.razorpayOrderId,
            name: resolvedDisplayName,
            location: dlLocation || order.customerPhone || order.customerEmail || "Direct Checkout",
            biodataLocation: dlLocation || null,
            customerName: resolvedDisplayName,
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

        // Format recent free downloads (exclude logs that are tied to orderIds)
        const formattedFreeLogs = (recentDownloadLogsRaw || [])
          .filter(log => !log.orderId)
          .map(log => {
            const template = templatesList.find(t => t.id === log.templateId);
            const resolvedDisplayName = getDisplayName(log.name, null, log.id, true);
            return {
              id: log.id,
              orderId: null,
              name: resolvedDisplayName,
              location: log.location || "Direct Download",
              biodataLocation: log.location || null,
              customerName: resolvedDisplayName,
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
        // Format failed orders and failed downloads
        const formattedFailedOrders = (recentFailedOrdersRaw || []).map(order => {
          const template = templatesList.find(t => t.id === order.templateId);
          const dlLocation = order.downloadLogs?.[0]?.location;
          const dlName = order.downloadLogs?.[0]?.name;
          const dlError = order.downloadLogs?.[0]?.errorMsg;
          const resolvedDisplayName = getDisplayName(order.customerName || dlName, order.razorpayOrderId, order.id, false);
          const failureReason = dlError || (order.status === "failed" ? "Payment checkout failed or was cancelled" : "Document generation / export failed");

          return {
            id: order.id,
            orderId: order.razorpayOrderId,
            name: resolvedDisplayName,
            location: dlLocation || order.customerPhone || order.customerEmail || "Direct Checkout",
            biodataLocation: dlLocation || null,
            customerName: resolvedDisplayName,
            customerEmail: order.customerEmail,
            customerPhone: order.customerPhone,
            format: (order.format || 'PDF').toUpperCase(),
            amount: Number((order.amount || 0).toFixed(2)),
            currency: order.currency || "INR",
            isFree: Number(order.amount || 0) === 0,
            paymentType: Number(order.amount || 0) === 0 ? "FREE" : "PAID",
            status: "FAILED",
            downloadStatus: "failed",
            errorMsg: failureReason,
            templateId: order.templateId,
            templateName: template ? template.name : "Premium Theme",
            razorpayOrderId: order.razorpayOrderId,
            createdAt: order.createdAt,
          };
        });

        const formattedFailedFreeLogs = (recentFailedLogsRaw || [])
          .filter(log => !log.orderId)
          .map(log => {
            const template = templatesList.find(t => t.id === log.templateId);
            const resolvedDisplayName = getDisplayName(log.name, null, log.id, true);
            return {
              id: log.id,
              orderId: null,
              name: resolvedDisplayName,
              location: log.location || "Direct Download",
              biodataLocation: log.location || null,
              customerName: resolvedDisplayName,
              customerEmail: null,
              customerPhone: null,
              format: (log.format || 'PDF').toUpperCase(),
              amount: 0,
              currency: "INR",
              isFree: true,
              paymentType: "FREE",
              status: "FAILED",
              downloadStatus: "failed",
              errorMsg: log.errorMsg || "Free download package generation failed",
              templateId: log.templateId,
              templateName: template ? template.name : "Standard Theme",
              razorpayOrderId: null,
              createdAt: log.createdAt,
            };
          });

        const recentFailedList = [...formattedFailedOrders, ...formattedFailedFreeLogs]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        const totalFailedCount = (totalFailedDownloadsCount || 0) + (totalFailedOrdersCount || 0);
        const failedTodayCount = (failedDownloadsTodayCount || 0) + (failedOrdersTodayCount || 0);
        const totalAttempts = totalDownloads + totalFailedCount;
        const failureRate = totalAttempts > 0 ? Number(((totalFailedCount / totalAttempts) * 100).toFixed(1)) : 0;

        const failedStats = {
          totalFailed: totalFailedCount,
          totalFailedDownloads: totalFailedDownloadsCount || 0,
          totalFailedPayments: totalFailedOrdersCount || 0,
          failedToday: failedTodayCount,
          failureRate,
          recentFailed: recentFailedList,
        };

        const recentTransactions = [...formattedOrders, ...formattedFreeLogs, ...recentFailedList]
          .filter((item, index, self) => index === self.findIndex(t => t.id === item.id))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 15);

        // Template popularity mapping
        let templatePopularity = (groupedPopularity || []).map((item) => {
          const template = templatesList.find((t) => t.id === item.templateId);
          return {
            name: template ? template.name : "Premium Theme",
            count: item._count?.templateId || 0,
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
        const totalReviews = feedbackCount || 0;
        const reviewsThisWeek = feedbackCountThisWeek || 0;
        const reviewsToday = feedbackCountToday || 0;
        const averageRating = feedbackAvg?._avg?.rating ? Number(feedbackAvg._avg.rating.toFixed(1)) : 5.0;

        const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        (feedbackRatingGroup || []).forEach(g => {
          if (g?.rating && ratingCounts[g.rating] !== undefined) {
            ratingCounts[g.rating] = g._count?.rating || 0;
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
          recentReviews: (recentFeedbackList || []).map(item => ({
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
          totalUsers: totalUsers || 0,
          newUsersToday: newUsersToday || 0,
          totalDownloads,
          totalPaidDownloads,
          totalFreeDownloads: totalFreeDownloads || 0,
          downloadsThisWeek,
          paidDownloadsThisWeek: paidOrdersThisWeek || 0,
          freeDownloadsThisWeek: freeDownloadsThisWeek || 0,
          totalRevenue,
          revenueToday,
          recentTransactions,
          recentDownloads: recentTransactions,
          templatePopularity,
          dailyTraffic,
          totalAffiliates: totalAffiliates || 0,
          newAffiliatesToday: newAffiliatesToday || 0,
          pendingAffiliateRequests: pendingAffiliateRequests || 0,
          pendingWithdrawalRequests: pendingWithdrawalRequests || 0,
          pendingCommissions: pendingCommissions || 0,
          reviewStats,
          failedStats,
        };
      });

      return reply.send({
        ...stats,
        liveMetrics: {
          criticalReviewsCount: stats.reviewStats?.criticalReviewsCount || 0,
          totalFailedCount: stats.failedStats?.totalFailed || 0,
          failedTodayCount: stats.failedStats?.failedToday || 0,
        },
        systemMetrics: null
      });
    } catch (error) {
      app.log.error("Dashboard stats error:", error);
      console.error("Dashboard stats error:", error);
      return reply.status(500).send({
        error: "Internal server error",
        message: error?.message || String(error)
      });
    }
  });
}

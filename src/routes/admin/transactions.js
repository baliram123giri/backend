import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

export default async function adminTransactionsRoutes(app, options) {
  // GET all transactions and biodatas with pagination, search, and filters
  app.get('/transactions', async (request, reply) => {
    try {
      const {
        search = '',
        status = '',
        format = '',
        downloadStatus = '',
        page = 1,
        limit = 20,
        bypass = 'false'
      } = request.query;

      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 20;
      const skip = (pageNum - 1) * limitNum;
      const bypassCache = bypass === 'true';

      const cacheKey = `transactions:${search}:${status}:${format}:${downloadStatus}:${page}:${limit}`;

      if (bypassCache && redis && redis.status === 'ready') {
        try {
          const keys = await redis.keys('transactions:*');
          if (keys.length > 0) {
            await redis.del(keys);
          }
        } catch (e) {
          console.warn('Redis clear cache error in transactions:', e.message);
        }
      }

      const result = await getCachedOrFetch(cacheKey, 60, async () => {
        const templates = await prisma.template.findMany({
          select: { id: true, name: true }
        }).catch(() => []);

        const isFreeFilter = status.toLowerCase() === 'free';
        const isPaidFilter = status.toLowerCase() === 'paid' || status.toLowerCase() === 'pending' || status.toLowerCase() === 'failed' || status.toLowerCase() === 'refunded' || status.toLowerCase() === 'cancelled';

        // Order where condition
        const orderWhere = {};
        if (status && status.toLowerCase() !== 'all' && !isFreeFilter) {
          orderWhere.status = status.toLowerCase();
        }
        if (format && format.toLowerCase() !== 'all') {
          orderWhere.format = format.toLowerCase();
        }
        if (downloadStatus && downloadStatus.toLowerCase() !== 'all') {
          if (downloadStatus.toLowerCase() === 'pending') {
            orderWhere.downloadStatus = null;
          } else {
            orderWhere.downloadStatus = downloadStatus.toLowerCase();
          }
        }
        if (search) {
          orderWhere.OR = [
            { razorpayOrderId: { contains: search, mode: 'insensitive' } },
            { razorpayPaymentId: { contains: search, mode: 'insensitive' } },
            { customerName: { contains: search, mode: 'insensitive' } },
            { customerEmail: { contains: search, mode: 'insensitive' } },
            { customerPhone: { contains: search, mode: 'insensitive' } },
            { couponCode: { contains: search, mode: 'insensitive' } },
          ];
        }

        // Free DownloadLog where condition
        const freeWhere = { orderId: null };
        if (format && format.toLowerCase() !== 'all') {
          freeWhere.format = { equals: format, mode: 'insensitive' };
        }
        if (downloadStatus && downloadStatus.toLowerCase() !== 'all') {
          if (downloadStatus.toLowerCase() === 'failed') {
            freeWhere.errorMsg = { not: null };
          } else if (downloadStatus.toLowerCase() === 'success') {
            freeWhere.errorMsg = null;
          }
        }
        if (search) {
          freeWhere.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { location: { contains: search, mode: 'insensitive' } },
            { ipAddress: { contains: search, mode: 'insensitive' } },
          ];
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

        let orders = [];
        let total = 0;

        if (isFreeFilter) {
          // Exclusively fetch Free Download Logs
          const [freeLogsRaw, freeCount] = await Promise.all([
            prisma.downloadLog.findMany({
              where: freeWhere,
              orderBy: { createdAt: 'desc' },
              skip,
              take: limitNum,
            }).catch(() => []),
            prisma.downloadLog.count({ where: freeWhere }).catch(() => 0),
          ]);

          orders = freeLogsRaw.map((log) => {
            const template = templates.find((t) => t.id === log.templateId);
            const resolvedName = getDisplayName(log.name, null, log.id, true);
            return {
              id: log.id,
              orderId: null,
              razorpayOrderId: null,
              razorpayPaymentId: null,
              amount: 0,
              currency: 'INR',
              isFree: true,
              paymentType: 'FREE',
              status: 'FREE',
              format: (log.format || 'PDF').toUpperCase(),
              customerName: resolvedName,
              biodataName: resolvedName,
              customerEmail: null,
              customerPhone: null,
              location: log.location || null,
              templateId: log.templateId,
              templateName: template ? template.name : 'Standard Theme',
              downloadStatus: log.errorMsg ? 'failed' : 'success',
              errorMsg: log.errorMsg,
              ipAddress: log.ipAddress,
              userAgent: log.userAgent,
              createdAt: log.createdAt,
            };
          });
          total = freeCount;
        } else if (isPaidFilter) {
          // Exclusively fetch Paid Orders
          const [ordersRaw, orderCount] = await Promise.all([
            prisma.order.findMany({
              where: orderWhere,
              orderBy: { createdAt: 'desc' },
              skip,
              take: limitNum,
              include: {
                downloadLogs: {
                  take: 1,
                  orderBy: { createdAt: 'desc' },
                  select: { location: true, name: true, ipAddress: true, userAgent: true }
                }
              }
            }).catch(() => []),
            prisma.order.count({ where: orderWhere }).catch(() => 0),
          ]);

          orders = ordersRaw.map((order) => {
            const template = templates.find((t) => t.id === order.templateId);
            const dl = order.downloadLogs?.[0];
            const resolvedName = getDisplayName(order.customerName || dl?.name, order.razorpayOrderId, order.id, false);
            return {
              id: order.id,
              orderId: order.razorpayOrderId,
              razorpayOrderId: order.razorpayOrderId,
              razorpayPaymentId: order.razorpayPaymentId,
              amount: Number((order.amount || 0).toFixed(2)),
              currency: order.currency || 'INR',
              isFree: false,
              paymentType: 'PAID',
              status: (order.status || 'PAID').toUpperCase(),
              format: (order.format || 'PDF').toUpperCase(),
              customerName: resolvedName,
              biodataName: resolvedName,
              customerEmail: order.customerEmail,
              customerPhone: order.customerPhone,
              couponCode: order.couponCode,
              discountApplied: order.discountApplied,
              location: dl?.location || null,
              templateId: order.templateId,
              templateName: template ? template.name : 'Premium Theme',
              downloadStatus: order.downloadStatus || 'pending',
              ipAddress: dl?.ipAddress || null,
              userAgent: dl?.userAgent || null,
              createdAt: order.createdAt,
            };
          });
          total = orderCount;
        } else {
          // Combined All: Fetch Paid Orders + Free Download Logs
          const [ordersRaw, orderCount, freeLogsRaw, freeCount] = await Promise.all([
            prisma.order.findMany({
              where: orderWhere,
              orderBy: { createdAt: 'desc' },
              take: 100,
              include: {
                downloadLogs: {
                  take: 1,
                  orderBy: { createdAt: 'desc' },
                  select: { location: true, name: true, ipAddress: true, userAgent: true }
                }
              }
            }).catch(() => []),
            prisma.order.count({ where: orderWhere }).catch(() => 0),
            prisma.downloadLog.findMany({
              where: freeWhere,
              orderBy: { createdAt: 'desc' },
              take: 100,
            }).catch(() => []),
            prisma.downloadLog.count({ where: freeWhere }).catch(() => 0),
          ]);

          const formattedOrders = ordersRaw.map((order) => {
            const template = templates.find((t) => t.id === order.templateId);
            const dl = order.downloadLogs?.[0];
            const resolvedName = getDisplayName(order.customerName || dl?.name, order.razorpayOrderId, order.id, false);
            return {
              id: order.id,
              orderId: order.razorpayOrderId,
              razorpayOrderId: order.razorpayOrderId,
              razorpayPaymentId: order.razorpayPaymentId,
              amount: Number((order.amount || 0).toFixed(2)),
              currency: order.currency || 'INR',
              isFree: false,
              paymentType: 'PAID',
              status: (order.status || 'PAID').toUpperCase(),
              format: (order.format || 'PDF').toUpperCase(),
              customerName: resolvedName,
              biodataName: resolvedName,
              customerEmail: order.customerEmail,
              customerPhone: order.customerPhone,
              couponCode: order.couponCode,
              discountApplied: order.discountApplied,
              location: dl?.location || null,
              templateId: order.templateId,
              templateName: template ? template.name : 'Premium Theme',
              downloadStatus: order.downloadStatus || 'pending',
              ipAddress: dl?.ipAddress || null,
              userAgent: dl?.userAgent || null,
              createdAt: order.createdAt,
            };
          });

          const formattedFreeLogs = freeLogsRaw.map((log) => {
            const template = templates.find((t) => t.id === log.templateId);
            const resolvedName = getDisplayName(log.name, null, log.id, true);
            return {
              id: log.id,
              orderId: null,
              razorpayOrderId: null,
              razorpayPaymentId: null,
              amount: 0,
              currency: 'INR',
              isFree: true,
              paymentType: 'FREE',
              status: 'FREE',
              format: (log.format || 'PDF').toUpperCase(),
              customerName: resolvedName,
              biodataName: resolvedName,
              customerEmail: null,
              customerPhone: null,
              location: log.location || null,
              templateId: log.templateId,
              templateName: template ? template.name : 'Standard Theme',
              downloadStatus: log.errorMsg ? 'failed' : 'success',
              errorMsg: log.errorMsg,
              ipAddress: log.ipAddress,
              userAgent: log.userAgent,
              createdAt: log.createdAt,
            };
          });

          const merged = [...formattedOrders, ...formattedFreeLogs]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

          total = orderCount + freeCount;
          orders = merged.slice(skip, skip + limitNum);
        }

        // Aggregate overall platform stats
        const [allPaidOrders, allPendingOrders, allFreeCount, totalOrdersCount] = await Promise.all([
          prisma.order.aggregate({
            where: { status: 'paid' },
            _sum: { amount: true },
            _count: { id: true },
          }).catch(() => ({ _sum: { amount: 0 }, _count: { id: 0 } })),
          prisma.order.count({ where: { status: 'pending' } }).catch(() => 0),
          prisma.downloadLog.count({ where: { orderId: null } }).catch(() => 0),
          prisma.order.count().catch(() => 0),
        ]);

        const totalRevenue = Number((allPaidOrders._sum?.amount || 0).toFixed(2));
        const paidCount = allPaidOrders._count?.id || 0;
        const totalBiodatasCount = totalOrdersCount + allFreeCount;
        const successRate = totalOrdersCount > 0 ? Math.round((paidCount / totalOrdersCount) * 100) : 100;

        return {
          success: true,
          orders,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.max(1, Math.ceil(total / limitNum)),
          },
          stats: {
            totalRevenue,
            totalTransactions: totalOrdersCount,
            totalBiodatasCount,
            paidCount,
            freeCount: allFreeCount,
            pendingCount: allPendingOrders,
            successRate,
          },
        };
      });

      return reply.send(result);
    } catch (error) {
      app.log.error('Fetch transactions error:', error);
      return reply.status(500).send({ error: 'Failed to fetch transactions' });
    }
  });

  // POST update transaction status
  app.post('/transactions/update-status', async (request, reply) => {
    try {
      const { orderId, orderIds, status, downloadStatus } = request.body || {};

      if (!orderId && (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0)) {
        return reply.status(400).send({ error: 'orderId or orderIds is required' });
      }

      const dataToUpdate = {};
      if (status) {
        const validStatuses = ["paid", "pending", "failed", "refunded", "cancelled"];
        const targetStatus = status.toLowerCase();
        if (validStatuses.includes(targetStatus)) {
          dataToUpdate.status = targetStatus;
        }
      }

      if (downloadStatus !== undefined) {
        const validDLStatuses = ["success", "failed", "pending"];
        const targetDLStatus = downloadStatus === null ? "pending" : String(downloadStatus).toLowerCase();
        if (validDLStatuses.includes(targetDLStatus)) {
          dataToUpdate.downloadStatus = targetDLStatus === "pending" ? null : targetDLStatus;
        }
      }

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        try {
          const keys = await redis.keys('transactions:*');
          if (keys.length > 0) await redis.del(keys);
          await redis.del('admin:dashboard-stats');
        } catch (e) {
          console.warn('Redis cache clear error:', e.message);
        }
      }

      if (orderIds && Array.isArray(orderIds)) {
        const updated = await prisma.order.updateMany({
          where: { id: { in: orderIds } },
          data: dataToUpdate,
        });

        return reply.send({
          success: true,
          message: `Transaction values updated for ${updated.count} orders`,
        });
      }

      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: dataToUpdate,
      }).catch(() => null);

      return reply.send({
        success: true,
        message: 'Transaction successfully updated',
        order: updatedOrder
      });
    } catch (error) {
      app.log.error('Update transaction status error:', error);
      return reply.status(500).send({ error: 'Failed to update transaction status' });
    }
  });

  // POST delete transaction(s) / biodata download record(s)
  app.post('/transactions/delete', async (request, reply) => {
    try {
      const { orderId, orderIds } = request.body || {};

      if (!orderId && (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0)) {
        return reply.status(400).send({ error: 'orderId or orderIds are required fields for deletion' });
      }

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        try {
          const keys = await redis.keys('transactions:*');
          if (keys.length > 0) await redis.del(keys);
          await redis.del('admin:dashboard-stats');
        } catch (e) {
          console.warn('Redis cache clear error:', e.message);
        }
      }

      const targetIds = orderIds && Array.isArray(orderIds) ? orderIds : [orderId];

      // 1. Check matching orders
      const targetOrders = await prisma.order.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, razorpayOrderId: true },
      }).catch(() => []);

      const rzOrderIds = targetOrders.map(o => o.razorpayOrderId).filter(Boolean);

      // 2. Delete linked download logs for orders
      if (rzOrderIds.length > 0) {
        await prisma.downloadLog.deleteMany({
          where: { orderId: { in: rzOrderIds } },
        }).catch(() => {});
      }

      // 3. Delete matching free download logs by direct ID
      const deletedLogs = await prisma.downloadLog.deleteMany({
        where: { id: { in: targetIds } },
      }).catch(() => ({ count: 0 }));

      // 4. Delete matching orders by direct ID
      const deletedOrders = await prisma.order.deleteMany({
        where: { id: { in: targetIds } },
      }).catch(() => ({ count: 0 }));

      const totalDeleted = (deletedOrders.count || 0) + (deletedLogs.count || 0);

      return reply.send({
        success: true,
        message: `Successfully deleted ${totalDeleted} record(s)`,
        deletedOrdersCount: deletedOrders.count || 0,
        deletedLogsCount: deletedLogs.count || 0,
      });
    } catch (error) {
      app.log.error('Delete transactions error:', error);
      return reply.status(500).send({ error: 'Failed to delete transaction' });
    }
  });
}

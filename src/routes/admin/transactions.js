import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

export default async function adminTransactionsRoutes(app, options) {
  // GET all transactions with pagination, search, and filters
  app.get('/transactions', async (request, reply) => {
    try {
      const { search = '', status = '', format = '', downloadStatus = '', page = 1, limit = 20, bypass = 'false' } = request.query;

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;
      const bypassCache = bypass === 'true';

      const cacheKey = `transactions:${search}:${status}:${format}:${downloadStatus}:${page}:${limit}`;

      if (bypassCache && redis && redis.status === 'ready') {
        const keys = await redis.keys('transactions:*');
        if (keys.length > 0) {
          await redis.del(keys);
        }
      }

      // Build filters query
      const where = {};
      if (status) {
        where.status = status.toLowerCase();
      }
      if (format) {
        where.format = format.toLowerCase();
      }
      if (downloadStatus) {
        if (downloadStatus.toLowerCase() === 'pending') {
          where.downloadStatus = null;
        } else {
          where.downloadStatus = downloadStatus.toLowerCase();
        }
      }
      if (search) {
        where.OR = [
          { razorpayOrderId: { contains: search, mode: 'insensitive' } },
          { razorpayPaymentId: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search, mode: 'insensitive' } },
          { couponCode: { contains: search, mode: 'insensitive' } },
        ];
      }

      const result = await getCachedOrFetch(cacheKey, 120, async () => {
        const [
          ordersRaw,
          total,
          templates,
          allPaidOrders,
          allPendingOrders,
          totalTransactions
        ] = await Promise.all([
          prisma.order.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limitNum,
          }),
          prisma.order.count({ where }),
          prisma.template.findMany({
            select: { id: true, name: true }
          }),
          prisma.order.aggregate({
            where: { status: 'paid' },
            _sum: { amount: true },
            _count: { id: true },
          }),
          prisma.order.count({ where: { status: 'pending' } }),
          prisma.order.count(),
        ]);

        const orders = ordersRaw.map((order) => {
          const template = templates.find((t) => t.id === order.templateId);
          return {
            ...order,
            templateName: template ? template.name : "Premium Theme",
            downloadStatus: order.downloadStatus || null,
          };
        });

        const totalRevenue = allPaidOrders._sum.amount || 0;
        const paidCount = allPaidOrders._count.id;
        const successRate = totalTransactions > 0 ? Math.round((paidCount / totalTransactions) * 100) : 100;

        return {
          success: true,
          orders,
          pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum),
          },
          stats: {
            totalRevenue,
            totalTransactions,
            paidCount,
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
      const { orderId, orderIds, status, downloadStatus } = request.body;

      if (!orderId && (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0)) {
        return reply.status(400).send({ error: 'orderId or orderIds is required' });
      }

      const dataToUpdate = {};
      if (status) {
        const validStatuses = ["paid", "pending", "failed", "refunded", "cancelled"];
        const targetStatus = status.toLowerCase();
        if (!validStatuses.includes(targetStatus)) {
          return reply.status(400).send({ error: 'Invalid transaction status' });
        }
        dataToUpdate.status = targetStatus;
      }

      if (downloadStatus !== undefined) {
        const validDLStatuses = ["success", "failed", "pending"];
        const targetDLStatus = downloadStatus === null ? "pending" : String(downloadStatus).toLowerCase();
        if (!validDLStatuses.includes(targetDLStatus)) {
          return reply.status(400).send({ error: 'Invalid download status' });
        }
        dataToUpdate.downloadStatus = targetDLStatus === "pending" ? null : targetDLStatus;
      }

      if (Object.keys(dataToUpdate).length === 0) {
        return reply.status(400).send({ error: 'No fields to update provided' });
      }

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        const keys = await redis.keys('transactions:*');
        if (keys.length > 0) await redis.del(keys);
        await redis.del('admin:dashboard-stats');
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
      });

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

  // POST delete transaction(s)
  app.post('/transactions/delete', async (request, reply) => {
    try {
      const { orderId, orderIds } = request.body;

      if (!orderId && (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0)) {
        return reply.status(400).send({ error: 'orderId or orderIds are required fields for deletion' });
      }

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        const keys = await redis.keys('transactions:*');
        if (keys.length > 0) await redis.del(keys);
        await redis.del('admin:dashboard-stats');
      }

      if (orderIds && Array.isArray(orderIds)) {
        const deleted = await prisma.order.deleteMany({
          where: { id: { in: orderIds } },
        });

        return reply.send({
          success: true,
          message: `Successfully deleted ${deleted.count} transaction records`,
        });
      }

      const deletedOrder = await prisma.order.delete({
        where: { id: orderId },
      });

      return reply.send({
        success: true,
        message: 'Successfully deleted transaction record',
        order: deletedOrder
      });
    } catch (error) {
      app.log.error('Delete transactions error:', error);
      return reply.status(500).send({ error: 'Failed to delete transaction' });
    }
  });
}

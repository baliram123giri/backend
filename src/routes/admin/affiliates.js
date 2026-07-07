import { prisma } from '../../lib/prisma.js';

export default async function adminAffiliateRoutes(fastify, options) {
  // 1. GET /api/admin/affiliates (which maps to /affiliates because of prefix /api/admin in parent register)
  fastify.get('/affiliates', async (request, reply) => {
    try {
      const affiliates = await prisma.affiliate.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              clicks: true,
              commissions: true,
              withdrawals: true
            }
          }
        }
      });
      return reply.send({ success: true, affiliates });
    } catch (error) {
      fastify.log.error('Admin Fetch Affiliates Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch affiliates', details: error.message });
    }
  });

  // 2. PUT /api/admin/affiliates/:id/status
  fastify.put('/affiliates/:id/status', async (request, reply) => {
    try {
      const { id } = request.params;
      const { status } = request.body || {};

      if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
        return reply.status(400).send({ error: 'Invalid status value' });
      }

      const updated = await prisma.affiliate.update({
        where: { id },
        data: { status }
      });

      // If approved, verify/update commissions status if needed
      return reply.send({ success: true, affiliate: updated });
    } catch (error) {
      fastify.log.error('Admin Update Affiliate Status Error:', error);
      return reply.status(500).send({ error: 'Failed to update affiliate status', details: error.message });
    }
  });

  // 3. GET /api/admin/affiliates/withdrawals (payouts dashboard)
  fastify.get('/affiliates/withdrawals', async (request, reply) => {
    try {
      const withdrawals = await prisma.withdrawal.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          affiliate: {
            select: {
              id: true,
              name: true,
              email: true,
              code: true,
              upiId: true,
              bankAccountName: true,
              bankAccountNumber: true,
              bankIfsc: true
            }
          }
        }
      });
      return reply.send({ success: true, withdrawals });
    } catch (error) {
      fastify.log.error('Admin Fetch Withdrawals Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch withdrawal requests', details: error.message });
    }
  });

  // 4. PUT /api/admin/affiliates/withdrawals/:id/status
  fastify.put('/affiliates/withdrawals/:id/status', async (request, reply) => {
    try {
      const { id } = request.params;
      const { status, notes } = request.body || {};

      if (!['paid', 'rejected'].includes(status)) {
        return reply.status(400).send({ error: 'Invalid status value. Must be paid or rejected.' });
      }

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id }
      });

      if (!withdrawal) {
        return reply.status(404).send({ error: 'Withdrawal request not found' });
      }

      if (withdrawal.status !== 'pending') {
        return reply.status(400).send({ error: 'Withdrawal request has already been processed' });
      }

      if (status === 'paid') {
        await prisma.$transaction([
          prisma.withdrawal.update({
            where: { id },
            data: { status: 'paid', paidAt: new Date(), notes }
          }),
          prisma.commission.updateMany({
            where: { withdrawalId: id },
            data: { status: 'paid', paidAt: new Date() }
          })
        ]);
      } else if (status === 'rejected') {
        await prisma.$transaction([
          prisma.withdrawal.update({
            where: { id },
            data: { status: 'rejected', notes }
          }),
          prisma.commission.updateMany({
            where: { withdrawalId: id },
            data: { withdrawalId: null } // Free them back up for a new withdrawal request
          })
        ]);
      }

      return reply.send({ success: true, message: `Withdrawal request ${status} successfully.` });
    } catch (error) {
      fastify.log.error('Admin Process Withdrawal Error:', error);
      return reply.status(500).send({ error: 'Failed to process withdrawal request', details: error.message });
    }
  });

  // 5. PUT /api/admin/affiliates/:id  — update any partner details (payout, notes, etc.)
  fastify.put('/affiliates/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { upiId, bankAccountName, bankAccountNumber, bankIfsc, notes, adminNotes, phone, tier, commissionRate } = request.body || {};

      const existing = await prisma.affiliate.findUnique({ where: { id } });
      if (!existing) return reply.status(404).send({ error: 'Affiliate not found.' });

      const data = {};

      // Update payout method
      if (upiId !== undefined) {
        if (upiId && upiId.trim().length > 0) {
          if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId.trim())) {
            return reply.status(400).send({ error: 'Invalid UPI ID format.' });
          }
          data.upiId = upiId.trim();
          data.bankAccountName = null;
          data.bankAccountNumber = null;
          data.bankIfsc = null;
        } else {
          data.upiId = null;
        }
      }

      if (bankAccountNumber !== undefined) {
        if (bankAccountNumber && bankAccountNumber.trim().length > 0) {
          if (!/^\d{9,18}$/.test(bankAccountNumber.trim()))
            return reply.status(400).send({ error: 'Account number must be 9–18 digits.' });
          if (!bankIfsc || !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(bankIfsc.trim()))
            return reply.status(400).send({ error: 'Invalid IFSC code format.' });
          if (!bankAccountName || bankAccountName.trim().length < 3)
            return reply.status(400).send({ error: 'Account holder name must be at least 3 characters.' });

          data.upiId = null;
          data.bankAccountName = bankAccountName.trim();
          data.bankAccountNumber = bankAccountNumber.trim();
          data.bankIfsc = bankIfsc.trim().toUpperCase();
        } else {
          data.bankAccountName = null;
          data.bankAccountNumber = null;
          data.bankIfsc = null;
        }
      }

      if (notes !== undefined) data.adminNotes = notes;
      if (adminNotes !== undefined) data.adminNotes = adminNotes;
      if (phone !== undefined) data.phone = phone;
      if (tier !== undefined) data.tier = tier;

      if (commissionRate !== undefined) {
        const rate = parseFloat(commissionRate);
        if (isNaN(rate) || rate < 0 || rate > 100) {
          return reply.status(400).send({ error: 'Commission rate must be a valid number between 0 and 100.' });
        }
        data.commissionRate = rate;
      }

      const updated = await prisma.affiliate.update({ where: { id }, data });
      return reply.send({ success: true, affiliate: updated });
    } catch (error) {
      fastify.log.error('Admin Update Affiliate Error:', error);
      return reply.status(500).send({ error: 'Failed to update affiliate details.', details: error.message });
    }
  });

  // 6. GET /api/admin/affiliates/:id/ledger (gets all transactions, commissions and withdrawals for a single affiliate)
  fastify.get('/affiliates/:id/ledger', async (request, reply) => {
    try {
      const { id } = request.params;
      
      const affiliate = await prisma.affiliate.findUnique({
        where: { id }
      });
      if (!affiliate) {
        return reply.status(404).send({ error: 'Affiliate not found.' });
      }

      const [commissions, withdrawals] = await Promise.all([
        prisma.commission.findMany({
          where: { affiliateId: id },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.withdrawal.findMany({
          where: { affiliateId: id },
          orderBy: { createdAt: 'desc' }
        })
      ]);

      return reply.send({
        success: true,
        commissions,
        withdrawals
      });
    } catch (error) {
      fastify.log.error('Admin Fetch Affiliate Ledger Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch affiliate ledger details.', details: error.message });
    }
  });

  // 7. PUT /api/admin/affiliates/commissions/:commId/status (updates individual commission status)
  fastify.put('/affiliates/commissions/:commId/status', async (request, reply) => {
    try {
      const { commId } = request.params;
      const { status } = request.body || {};

      if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) {
        return reply.status(400).send({ error: 'Invalid commission status value.' });
      }

      const commission = await prisma.commission.findUnique({
        where: { id: commId }
      });

      if (!commission) {
        return reply.status(404).send({ error: 'Commission record not found.' });
      }

      const data = { status };
      if (status === 'approved') {
        data.approvedAt = new Date();
      } else if (status === 'paid') {
        data.paidAt = new Date();
      }

      const updated = await prisma.commission.update({
        where: { id: commId },
        data
      });

      return reply.send({ success: true, commission: updated });
    } catch (error) {
      fastify.log.error('Admin Update Commission Status Error:', error);
      return reply.status(500).send({ error: 'Failed to update commission status.', details: error.message });
    }
  });

  // 8. POST /api/admin/affiliates/:id/commissions (adds a manual bonus/commission for an affiliate)
  fastify.post('/affiliates/:id/commissions', async (request, reply) => {
    try {
      const { id } = request.params;
      const { amount, notes } = request.body || {};

      const affiliate = await prisma.affiliate.findUnique({
        where: { id }
      });

      if (!affiliate) {
        return reply.status(404).send({ error: 'Affiliate partner not found.' });
      }

      const commissionAmount = parseFloat(amount);
      if (isNaN(commissionAmount) || commissionAmount <= 0) {
        return reply.status(400).send({ error: 'Invalid commission amount. Must be a positive number.' });
      }

      const cleanNotes = (notes || 'Manual Bonus').trim();
      const orderId = Date.now().toString();

      const newCommission = await prisma.commission.create({
        data: {
          affiliateId: id,
          orderId,
          orderAmount: 0,
          commissionAmount,
          status: 'approved',
          notes: cleanNotes,
          approvedAt: new Date()
        }
      });

      return reply.send({ success: true, commission: newCommission });
    } catch (error) {
      fastify.log.error('Admin Add Manual Commission Error:', error);
      return reply.status(500).send({ error: 'Failed to add manual commission.', details: error.message });
    }
  });
}

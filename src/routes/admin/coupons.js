import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';

const CACHE_KEY = "admin:coupons";

export function normalizeExpiryDate(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Pure date: YYYY-MM-DD -> set to 23:59:59.999 in IST (+05:30)
    const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      return new Date(`${trimmed}T23:59:59.999+05:30`);
    }
    // ISO string with midnight 00:00:00 (e.g. from frontend new Date('YYYY-MM-DD').toISOString())
    const isoMidnightMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00/);
    if (isoMidnightMatch) {
      const datePart = isoMidnightMatch[0].substring(0, 10);
      return new Date(`${datePart}T23:59:59.999+05:30`);
    }
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

export default async function adminCouponsRoutes(app, options) {
  // GET all coupons
  app.get('/coupons', async (request, reply) => {
    try {
      const coupons = await getCachedOrFetch(CACHE_KEY, 300, async () => {
        return prisma.coupon.findMany({
          orderBy: { createdAt: 'desc' }
        });
      });

      return reply.send({ success: true, coupons });
    } catch (error) {
      app.log.error('GET Coupons Error:', error);
      return reply.status(500).send({ error: 'Failed to fetch coupons' });
    }
  });

  // POST create a new coupon
  app.post('/coupons', async (request, reply) => {
    try {
      const { code, discountType, discountValue, active, isPublic, maxUses, expiresAt } = request.body;

      const missingFields = [];
      if (!code) missingFields.push('code');
      if (!discountType) missingFields.push('discountType');
      if (discountValue === undefined) missingFields.push('discountValue');

      if (missingFields.length > 0) {
        return reply.status(400).send({ error: `Missing required fields: ${missingFields.join(', ')}` });
      }

      const cleanCode = code.trim().toUpperCase();

      const existing = await prisma.coupon.findUnique({
        where: { code: cleanCode }
      });

      if (existing) {
        return reply.status(409).send({ error: 'A coupon with this code already exists' });
      }

      const coupon = await prisma.coupon.create({
        data: {
          code: cleanCode,
          discountType,
          discountValue: parseFloat(discountValue),
          active: active !== undefined ? active : true,
          isPublic: isPublic !== undefined ? isPublic : true,
          maxUses: maxUses ? parseInt(maxUses) : null,
          expiresAt: normalizeExpiryDate(expiresAt),
        }
      });

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(CACHE_KEY);
        await redis.del('active-coupons');
      }

      return reply.send({ success: true, coupon });
    } catch (error) {
      app.log.error('Create Coupon Error:', error);
      return reply.status(500).send({ error: 'Failed to create coupon' });
    }
  });

  // PUT/PATCH update a coupon by ID
  app.route({
    method: ['PUT', 'PATCH'],
    url: '/coupons/:id',
    handler: async (request, reply) => {
      try {
        const { id } = request.params;
        const { active, isPublic, code, discountType, discountValue, maxUses, expiresAt } = request.body;

        const dataToUpdate = {};
        if (active !== undefined) dataToUpdate.active = active;
        if (isPublic !== undefined) dataToUpdate.isPublic = isPublic;
        if (code !== undefined) dataToUpdate.code = code.trim().toUpperCase();
        if (discountType !== undefined) dataToUpdate.discountType = discountType;
        if (discountValue !== undefined) dataToUpdate.discountValue = parseFloat(discountValue);
        if (maxUses !== undefined) dataToUpdate.maxUses = maxUses ? parseInt(maxUses) : null;
        if (expiresAt !== undefined) dataToUpdate.expiresAt = normalizeExpiryDate(expiresAt);

        const updated = await prisma.coupon.update({
          where: { id },
          data: dataToUpdate
        });

        // Invalidate cache
        if (redis && redis.status === 'ready') {
          await redis.del(CACHE_KEY);
          await redis.del('active-coupons');
        }

        return reply.send({ success: true, coupon: updated });
      } catch (error) {
        app.log.error('Update Coupon Error:', error);
        return reply.status(500).send({ error: 'Failed to update coupon' });
      }
    }
  });

  // DELETE coupons (accepts body with either id or array of ids)
  const deleteHandler = async (request, reply) => {
    try {
      const { id, ids } = request.body;
      const targetIds = ids || (id ? [id] : null);

      if (!targetIds || !Array.isArray(targetIds) || targetIds.length === 0) {
        return reply.status(400).send({ error: 'ID or IDs are required' });
      }

      await prisma.coupon.deleteMany({
        where: {
          id: { in: targetIds }
        }
      });

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(CACHE_KEY);
        await redis.del('active-coupons');
      }

      return reply.send({ success: true, message: `${targetIds.length} coupons deleted successfully` });
    } catch (error) {
      app.log.error('Delete Coupon Error:', error);
      return reply.status(500).send({ error: 'Failed to delete coupons' });
    }
  };

  app.delete('/coupons', deleteHandler);
  app.post('/coupons/delete', deleteHandler);
}

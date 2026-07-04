import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { uploadToVPS, deleteFromVPS } from '../../lib/vps-upload.js';

export default async function adminBackgroundRoutes(fastify, options) {

  async function clearBackgroundCaches() {
    if (redis && redis.status === 'ready') {
      try {
        const keys = await redis.keys('backgrounds:*');
        if (keys && keys.length > 0) {
          await redis.del(keys);
        }
      } catch (err) {
        fastify.log.error('Clear background caches error:', err);
      }
    }
  }

  // GET all backgrounds
  fastify.get('/backgrounds', async (request, reply) => {
    try {
      const backgrounds = await prisma.background.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return { backgrounds };
    } catch (error) {
      request.log.error('List admin backgrounds error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST create a background
  fastify.post('/backgrounds', async (request, reply) => {
    try {
      const { name, file } = request.body;
      const missingFields = [];
      if (!name) missingFields.push('name');
      if (!file) missingFields.push('file');

      if (missingFields.length > 0) {
        return reply.status(400).send({ error: `Missing required fields: ${missingFields.join(', ')}` });
      }

      // Upload file to VPS
      const url = await uploadToVPS(file, 'backgrounds');

      // Save to database
      const background = await prisma.background.create({
        data: { name, url }
      });

      // Clear caches
      await clearBackgroundCaches();

      return { success: true, background };
    } catch (error) {
      request.log.error('Create admin background error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  // PATCH update a background
  fastify.patch('/backgrounds/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, file } = request.body;

      const existing = await prisma.background.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Background not found' });
      }

      let url = existing.url;
      if (file) {
        // Delete old file
        await deleteFromVPS(existing.url);
        // Upload new file
        url = await uploadToVPS(file, 'backgrounds');
      }

      const updated = await prisma.background.update({
        where: { id },
        data: {
          name: name !== undefined ? name : existing.name,
          url
        }
      });

      // Clear caches
      await clearBackgroundCaches();

      return { success: true, background: updated };
    } catch (error) {
      request.log.error('Update admin background error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  // DELETE a background
  fastify.delete('/backgrounds/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const existing = await prisma.background.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Background not found' });
      }

      // Delete file from VPS
      await deleteFromVPS(existing.url);

      // Delete from DB
      await prisma.background.delete({
        where: { id }
      });

      // Clear caches
      await clearBackgroundCaches();

      return { success: true, message: 'Background deleted successfully' };
    } catch (error) {
      request.log.error('Delete admin background error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

}

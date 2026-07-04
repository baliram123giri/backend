import { prisma } from '../../lib/prisma.js';

export default async function adminMantrasRoutes(fastify, options) {

  // GET all mantras
  fastify.get('/mantras', async (request, reply) => {
    try {
      const mantras = await prisma.mantra.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return { mantras };
    } catch (error) {
      request.log.error('List admin mantras error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST create a mantra
  fastify.post('/mantras', async (request, reply) => {
    try {
      const { religion, text, nativeText, meaning } = request.body;
      const missingFields = [];
      if (!religion) missingFields.push('religion');
      if (!text) missingFields.push('text');

      if (missingFields.length > 0) {
        return reply.status(400).send({ error: `Missing required fields: ${missingFields.join(', ')}` });
      }

      const mantra = await prisma.mantra.create({
        data: {
          religion,
          text,
          nativeText: nativeText || null,
          meaning: meaning || null
        }
      });

      return { success: true, mantra };
    } catch (error) {
      request.log.error('Create admin mantra error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PATCH update a mantra
  fastify.patch('/mantras/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { religion, text, nativeText, meaning } = request.body;

      const existing = await prisma.mantra.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Mantra not found' });
      }

      const updated = await prisma.mantra.update({
        where: { id },
        data: {
          religion: religion !== undefined ? religion : existing.religion,
          text: text !== undefined ? text : existing.text,
          nativeText: nativeText !== undefined ? nativeText : existing.nativeText,
          meaning: meaning !== undefined ? meaning : existing.meaning
        }
      });

      return { success: true, mantra: updated };
    } catch (error) {
      request.log.error('Update admin mantra error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE a mantra
  fastify.delete('/mantras/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const existing = await prisma.mantra.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Mantra not found' });
      }

      await prisma.mantra.delete({
        where: { id }
      });

      return { success: true, message: 'Mantra deleted successfully' };
    } catch (error) {
      request.log.error('Delete admin mantra error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

}

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { uploadToVPS, deleteFromVPS } from '../../lib/vps-upload.js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

export default async function adminStickersRoutes(fastify, options) {

  async function clearStickersCaches() {
    if (redis && redis.status === 'ready') {
      try {
        const keys = await redis.keys('stickers:*');
        if (keys && keys.length > 0) {
          await redis.del(keys);
        }
      } catch (err) {
        fastify.log.error('Clear stickers caches error:', err);
      }
    }
  }

  // GET all stickers (with pagination)
  fastify.get('/stickers', async (request, reply) => {
    try {
      const limit = parseInt(request.query.limit || '12', 10);
      const cursor = request.query.cursor || undefined;

      const stickers = await prisma.sticker.findMany({
        take: limit,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: 'desc' }
      });

      const nextCursor = stickers.length === limit ? stickers[stickers.length - 1].id : null;
      return { success: true, stickers, nextCursor };
    } catch (error) {
      request.log.error('List admin stickers error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST create a sticker
  fastify.post('/stickers', async (request, reply) => {
    try {
      const { name, type, religion, file } = request.body;
      const missingFields = [];
      if (!name) missingFields.push('name');
      if (!file) missingFields.push('file');

      if (missingFields.length > 0) {
        return reply.status(400).send({ error: `Missing required fields: ${missingFields.join(', ')}` });
      }

      // Upload file to VPS
      const url = await uploadToVPS(file, 'stickers');

      // Save to database
      const sticker = await prisma.sticker.create({
        data: {
          name,
          url,
          type: type || 'Normal',
          religion: religion || null
        }
      });

      // Clear caches
      await clearStickersCaches();

      return { success: true, sticker };
    } catch (error) {
      request.log.error('Create admin sticker error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  // PATCH update a sticker
  fastify.patch('/stickers/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, type, religion, file } = request.body;

      const existing = await prisma.sticker.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Sticker not found' });
      }

      let url = existing.url;
      if (file) {
        // Delete old file
        await deleteFromVPS(existing.url);
        // Upload new file
        url = await uploadToVPS(file, 'stickers');
      }

      const updated = await prisma.sticker.update({
        where: { id },
        data: {
          name: name !== undefined ? name : existing.name,
          type: type !== undefined ? type : existing.type,
          religion: religion !== undefined ? religion : existing.religion,
          url
        }
      });

      // Clear caches
      await clearStickersCaches();

      return { success: true, sticker: updated };
    } catch (error) {
      request.log.error('Update admin sticker error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  // DELETE a sticker
  fastify.delete('/stickers/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const existing = await prisma.sticker.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Sticker not found' });
      }

      // Delete file from VPS
      await deleteFromVPS(existing.url);

      // Delete from DB
      await prisma.sticker.delete({
        where: { id }
      });

      // Clear caches
      await clearStickersCaches();

      return { success: true, message: 'Sticker deleted successfully' };
    } catch (error) {
      request.log.error('Delete admin sticker error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST analyze image with AI
  fastify.post('/stickers/analyze-image', async (request, reply) => {
    try {
      const { file } = request.body;
      if (!file) {
        return reply.status(400).send({ error: 'File is required' });
      }

      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return { name: 'Suggested Asset' };
      }

      let base64Data = file;
      let mimeType = 'image/png';
      if (file.startsWith('data:')) {
        const commaIndex = file.indexOf(',');
        const header = file.substring(0, commaIndex);
        base64Data = file.substring(commaIndex + 1);
        const mimeMatch = header.match(/data:([^;]+)/);
        mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
      }

      const buffer = Buffer.from(base64Data, 'base64');
      const googleProvider = createGoogleGenerativeAI({ apiKey });

      const { text } = await generateText({
        model: googleProvider('gemini-2.5-flash'),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe the main subject/symbol of this image in a short, clean, descriptive 2-4 word English phrase (e.g. "Ganesha Sticker", "Golden Peacock Border", "Coconut Kalash", "Heart Design"). Return ONLY the phrase, with no quotes, punctuation, or other text.' },
              { type: 'image', image: buffer, mimeType: mimeType }
            ]
          }
        ]
      });

      const suggestedName = text.trim().replace(/^['"\s]+|['"\s]+$/g, '');
      return { name: suggestedName || 'Suggested Asset' };
    } catch (error) {
      request.log.error('AI image analysis error:', error);
      return { name: 'Suggested Asset' };
    }
  });

}

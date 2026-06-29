import { prisma } from '../../lib/prisma.js';
import { redis, getCachedOrFetch } from '../../lib/redis.js';
import { uploadToVPS, deleteFromVPS } from '../../lib/vps-upload.js';

const HERO_SLIDES_CACHE_KEY = "admin:hero-slides";

export default async function adminHeroSlidesRoutes(app, options) {
  // GET all slides (including inactive ones for admin review)
  app.get('/hero-slides', async (request, reply) => {
    try {
      const slides = await getCachedOrFetch(HERO_SLIDES_CACHE_KEY, 300, async () => {
        return prisma.heroSlide.findMany({
          orderBy: { order: 'asc' }
        });
      });
      return reply.send({ success: true, slides });
    } catch (error) {
      app.log.error('List admin hero slides error:', error);
      return reply.status(500).send({ error: 'Failed to fetch hero slides' });
    }
  });

  // POST create a new hero slide
  app.post('/hero-slides', async (request, reply) => {
    try {
      const { title, imageFile, order, active } = request.body;

      if (!imageFile) {
        return reply.status(400).send({ error: 'Image file is required' });
      }

      // Upload image to client public directory
      const imageUrl = await uploadToVPS(imageFile, 'hero_slides');

      const slide = await prisma.heroSlide.create({
        data: {
          title: title || '',
          imageUrl,
          order: typeof order === 'number' ? order : 0,
          active: active !== false,
        }
      });

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(HERO_SLIDES_CACHE_KEY);
        await redis.del('hero-slides');
      }

      return reply.send({ success: true, slide });
    } catch (error) {
      app.log.error('Create hero slide error:', error);
      return reply.status(500).send({ error: 'Failed to create hero slide' });
    }
  });

  // PUT update hero slide
  app.put('/hero-slides/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { title, active, order, imageFile } = request.body;

      const dataToUpdate = {};
      if (title !== undefined) dataToUpdate.title = title;
      if (active !== undefined) dataToUpdate.active = active;
      if (order !== undefined) dataToUpdate.order = parseInt(order);

      if (imageFile) {
        // Delete old slide image first if we find it
        const current = await prisma.heroSlide.findUnique({ where: { id } });
        if (current && current.imageUrl) {
          await deleteFromVPS(current.imageUrl);
        }
        dataToUpdate.imageUrl = await uploadToVPS(imageFile, 'hero_slides');
      }

      const updated = await prisma.heroSlide.update({
        where: { id },
        data: dataToUpdate
      });

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(HERO_SLIDES_CACHE_KEY);
        await redis.del('hero-slides');
      }

      return reply.send({ success: true, slide: updated });
    } catch (error) {
      app.log.error('Update hero slide error:', error);
      return reply.status(500).send({ error: 'Failed to update hero slide' });
    }
  });

  // POST reorder slides
  app.post('/hero-slides/reorder', async (request, reply) => {
    try {
      const { slides } = request.body; // Array of { id, order }

      if (!slides || !Array.isArray(slides)) {
        return reply.status(400).send({ error: 'Slides array is required' });
      }

      await Promise.all(
        slides.map(slide =>
          prisma.heroSlide.update({
            where: { id: slide.id },
            data: { order: slide.order }
          })
        )
      );

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(HERO_SLIDES_CACHE_KEY);
        await redis.del('hero-slides');
      }

      return reply.send({ success: true, message: 'Slides reordered successfully' });
    } catch (error) {
      app.log.error('Reorder hero slides error:', error);
      return reply.status(500).send({ error: 'Failed to reorder hero slides' });
    }
  });

  // DELETE a hero slide
  app.delete('/hero-slides/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const current = await prisma.heroSlide.findUnique({ where: { id } });
      if (current && current.imageUrl) {
        await deleteFromVPS(current.imageUrl);
      }

      await prisma.heroSlide.delete({
        where: { id }
      });

      // Invalidate cache
      if (redis && redis.status === 'ready') {
        await redis.del(HERO_SLIDES_CACHE_KEY);
        await redis.del('hero-slides');
      }

      return reply.send({ success: true, message: 'Hero slide deleted successfully' });
    } catch (error) {
      app.log.error('Delete hero slide error:', error);
      return reply.status(500).send({ error: 'Failed to delete hero slide' });
    }
  });
}

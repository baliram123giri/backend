import { prisma, withRetry } from '../../lib/prisma.js';
import { getCachedOrFetch } from '../../lib/redis.js';
import { mapDbTemplateToConfig } from '../../../helpers.js';

export default async function publicTemplateRoutes(app, options) {
  // -------------------------------------------------------------
  // 1. GET /api/templates
  // -------------------------------------------------------------
  app.get('/api/templates', async (request, reply) => {
    try {
      const onlyDefault = request.query.default === 'true';
      const templateId = request.query.id;
      const limit = parseInt(request.query.limit || '0') || 0;
      const page = parseInt(request.query.page || '1') || 1;
      const religion = request.query.religion;

      const cacheKey = `templates:id=${templateId || ''}:default=${onlyDefault}:religion=${religion || ''}:limit=${limit}:page=${page}`;

      const data = await getCachedOrFetch(cacheKey, 300, async () => {
        if (onlyDefault) {
          const whereClause = { active: true };
          if (religion) {
            whereClause.religion = { equals: religion, mode: 'insensitive' };
          }

          // Execute fallback queries in parallel to save database round-trips
          const [defaultTemplate, latestMatchingTemplate, latestAnyTemplate] = await Promise.all([
            withRetry(() =>
              prisma.template.findFirst({
                where: { ...whereClause, isDefault: true },
              })
            ),
            withRetry(() =>
              prisma.template.findFirst({
                where: whereClause,
                orderBy: { createdAt: 'desc' },
              })
            ),
            withRetry(() =>
              prisma.template.findFirst({
                where: { active: true },
                orderBy: { createdAt: 'desc' },
              })
            )
          ]);

          const finalPrimaryTemplate = defaultTemplate || latestMatchingTemplate || latestAnyTemplate;

          if (!finalPrimaryTemplate) {
            return { templates: [] };
          }

          if (limit > 1) {
            const [others, total] = await Promise.all([
              withRetry(() =>
                prisma.template.findMany({
                  where: { ...whereClause, id: { not: finalPrimaryTemplate.id } },
                  orderBy: { createdAt: 'desc' },
                  take: limit - 1,
                })
              ),
              withRetry(() => prisma.template.count({ where: whereClause })),
            ]);
            const templates = [finalPrimaryTemplate, ...others].map(mapDbTemplateToConfig);
            const hasMore = templates.length < total;
            return { templates, hasMore, total };
          }

          return { templates: [mapDbTemplateToConfig(finalPrimaryTemplate)], hasMore: false, total: 1 };
        }

        if (templateId) {
          const dbTemplate = await withRetry(() =>
            prisma.template.findUnique({
              where: { id: templateId, active: true },
            })
          );

          const templates = dbTemplate ? [mapDbTemplateToConfig(dbTemplate)] : [];
          return { templates };
        }

        const pageLimit = limit > 0 ? limit : 10;
        const skip = (page - 1) * pageLimit;

        const whereClause = { active: true };
        if (religion) {
          whereClause.religion = { equals: religion, mode: 'insensitive' };
        }

        const [dbTemplates, total] = await Promise.all([
          withRetry(() =>
            prisma.template.findMany({
              where: whereClause,
              orderBy: { createdAt: 'desc' },
              skip,
              take: pageLimit,
            })
          ),
          withRetry(() => prisma.template.count({ where: whereClause })),
        ]);

        const templates = dbTemplates.map(mapDbTemplateToConfig);
        const hasMore = skip + dbTemplates.length < total;
        return { templates, hasMore, total };
      });

      return data;
    } catch (error) {
      app.log.error('Fetch templates database error:', error);
      reply.status(500).send({ templates: [], error: error.message });
    }
  });

  // -------------------------------------------------------------
  // 2. GET /api/templates/thumbnails
  // -------------------------------------------------------------
  app.get('/api/templates/thumbnails', async (request, reply) => {
    try {
      const cacheKey = 'templates:thumbnails';
      const data = await getCachedOrFetch(cacheKey, 600, async () => {
        const dbTemplates = await withRetry(() =>
          prisma.template.findMany({
            where: { active: true },
            select: {
              id: true,
              name: true,
              thumbnailUrl: true,
              language: true,
              religion: true,
              gender: true,
              isPremium: true,
              price: true,
              discountPrice: true,
              jpgPrice: true,
              jpgDiscountPrice: true,
            },
            orderBy: { createdAt: 'desc' },
          })
        );
        return { templates: dbTemplates };
      });

      return data;
    } catch (error) {
      app.log.error('Fetch template thumbnails database error:', error);
      reply.status(500).send({ templates: [], error: error.message });
    }
  });
}

import { adminAuth } from '../../middleware/adminAuth.js';
import adminTemplateRoutes from './templates.js';
import adminLoginRoutes from './login.js';
import adminDashboardRoutes from './dashboard.js';
import adminTransactionsRoutes from './transactions.js';
import adminCouponsRoutes from './coupons.js';
import adminFeedbackRoutes from './feedback.js';
import adminBlogRoutes from './blog.js';
import adminBackgroundsRoutes from './backgrounds.js';
import adminStickersRoutes from './stickers.js';
import adminMantrasRoutes from './mantras.js';
import adminFlushCacheRoutes from './flush-cache.js';
import adminHeroSlidesRoutes from './hero-slides.js';
import adminUsersRoutes from './users.js';
import adminAffiliateRoutes from './affiliates.js';

export default async function adminRoutes(fastify, options) {
  // Add preHandler hook for administration authentication (login route will bypass this check internally)
  fastify.addHook('preHandler', adminAuth);

  // Register all admin sub-routes
  await fastify.register(adminLoginRoutes);
  await fastify.register(adminTemplateRoutes);
  await fastify.register(adminDashboardRoutes);
  await fastify.register(adminTransactionsRoutes);
  await fastify.register(adminCouponsRoutes);
  await fastify.register(adminFeedbackRoutes);
  await fastify.register(adminBlogRoutes);
  await fastify.register(adminBackgroundsRoutes);
  await fastify.register(adminStickersRoutes);
  await fastify.register(adminMantrasRoutes);
  await fastify.register(adminFlushCacheRoutes);
  await fastify.register(adminHeroSlidesRoutes);
  await fastify.register(adminUsersRoutes);
  await fastify.register(adminAffiliateRoutes);
}

import adminTemplateRoutes from './templates.js';
import adminLoginRoutes from './login.js';
import adminDashboardRoutes from './dashboard.js';
import adminTransactionsRoutes from './transactions.js';
import adminCouponsRoutes from './coupons.js';
import adminFeedbackRoutes from './feedback.js';
import adminBlogRoutes from './blog.js';
import adminBackgroundRoutes from './backgrounds.js';
import adminStickersRoutes from './stickers.js';
import adminMantrasRoutes from './mantras.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default async function adminRoutes(fastify, options) {
  // Apply the admin API key middleware to all admin routes
  fastify.addHook('preHandler', adminAuth);

  // Register admin sub-routes
  fastify.register(adminLoginRoutes);
  fastify.register(adminTemplateRoutes);
  fastify.register(adminDashboardRoutes);
  fastify.register(adminTransactionsRoutes);
  fastify.register(adminCouponsRoutes);
  fastify.register(adminFeedbackRoutes);
  fastify.register(adminBlogRoutes);
  fastify.register(adminBackgroundRoutes);
  fastify.register(adminStickersRoutes);
  fastify.register(adminMantrasRoutes);
}

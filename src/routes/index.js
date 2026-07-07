import adminRoutes from './admin/index.js';
import aiRoutes from './ai/index.js';
import assetsRoutes from './assets/index.js';
import diagnosticRoutes from './diagnostic/index.js';
import paymentsRoutes from './payments/index.js';
import proxyRoutes from './proxy/index.js';
import stickersRoutes from './stickers/index.js';
import publicTemplateRoutes from './templates/index.js';
import userRoutes from './user/index.js';
import whatsappRoutes from './whatsapp/index.js';
import affiliateRoutes from './affiliate/index.js';
import blogRoutes from './blog/index.js';

export default async function appRoutes(app, options) {
  // 1. Diagnostic / Health routes
  await app.register(diagnosticRoutes);

  // 2. Admin routes
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // 3. Affiliate routes
  await app.register(affiliateRoutes, { prefix: '/api/affiliate' });

  // 4. Other core API routes
  await app.register(aiRoutes);
  await app.register(assetsRoutes);
  await app.register(paymentsRoutes);
  await app.register(proxyRoutes);
  await app.register(stickersRoutes);
  await app.register(publicTemplateRoutes);
  await app.register(userRoutes);
  await app.register(whatsappRoutes);
  await app.register(blogRoutes);
}

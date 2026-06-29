import adminRoutes from './admin/index.js';
import aiRoutes from './ai/index.js';
import assetsRoutes from './assets/index.js';
import diagnosticRoutes from './diagnostic/index.js';
import paymentsRoutes from './payments/index.js';
import proxyRoutes from './proxy/index.js';
import stickersRoutes from './stickers/index.js';
import templatesRoutes from './templates/index.js';
import userRoutes from './user/index.js';
import whatsappRoutes from './whatsapp/index.js';
import blogRoutes from './blog/index.js';

export default async function appRoutes(app, options) {
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(aiRoutes);
  app.register(assetsRoutes);
  app.register(diagnosticRoutes);
  app.register(paymentsRoutes);
  app.register(proxyRoutes);
  app.register(stickersRoutes);
  app.register(templatesRoutes);
  app.register(userRoutes);
  app.register(whatsappRoutes);
  app.register(blogRoutes);
}

import fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { loggerConfig } from './src/lib/logger.js';
import appRoutes from './src/routes/index.js';

dotenv.config();

// Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_DSN || '', // Add SENTRY_DSN to your .env
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0, // Capture 100% of transactions for performance monitoring
  profilesSampleRate: 1.0,
  environment: process.env.NODE_ENV || 'development',
});

// Create Fastify server
const app = fastify({ 
  logger: loggerConfig,
  bodyLimit: 50 * 1024 * 1024 // 50MB limit to handle large base64 template images
});

// Register CORS
await app.register(fastifyCors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'x-admin-key',
    'x-affiliate-token',
    'Cache-Control',
    'Pragma',
    'Expires',
    'Access-Control-Request-Private-Network',
    'x-requested-with',
    'content-type',
    'accept',
    'authorization',
    'cache-control',
    'pragma',
    'expires',
  ],
  exposedHeaders: ['*'],
  preflight: true,
  strictPreflight: false,
});

// Set headers on all API responses
app.addHook('onRequest', async (request, reply) => {
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
});

app.addHook('onSend', async (request, reply, payload) => {
  if (request.headers['access-control-request-private-network']) {
    reply.header('Access-Control-Allow-Private-Network', 'true');
  }
  return payload;
});

// Serve robots.txt to disallow all crawlers
app.get('/robots.txt', async (request, reply) => {
  reply.type('text/plain');
  return 'User-agent: *\nDisallow: /\n';
});

// Register all modular routes
app.register(appRoutes);

// Global Sentry Error Handler with guaranteed CORS headers
app.setErrorHandler((error, request, reply) => {
  // Only capture 500+ errors or unhandled exceptions to Sentry
  if (!error.statusCode || error.statusCode >= 500) {
    Sentry.captureException(error);
  }
  
  app.log.error(error);

  const origin = request.headers.origin;
  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
  } else {
    reply.header('Access-Control-Allow-Origin', '*');
  }

  reply.status(error.statusCode || 500).send({ 
    error: error.message || 'Internal Server Error' 
  });
});

// 404 Handler with guaranteed CORS headers
app.setNotFoundHandler((request, reply) => {
  const origin = request.headers.origin;
  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
  } else {
    reply.header('Access-Control-Allow-Origin', '*');
  }
  reply.status(404).send({ error: 'Route not found' });
});

// Start Server
const start = async () => {
  try {
    const port = process.env.PORT || 4000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Fastify server is running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

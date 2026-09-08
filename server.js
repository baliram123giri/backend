import fastify from 'fastify';
import querystring from 'querystring';
import fastifyCors from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifyRateLimit from '@fastify/rate-limit';
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { loggerConfig } from './src/lib/logger.js';
import { prisma } from './src/lib/prisma.js';
import { redis } from './src/lib/redis.js';
import { closeChromiumBrowser } from './src/services/pdfGenerator.js';
import appRoutes from './src/routes/index.js';

dotenv.config();

// Initialize Sentry (only when DSN is present to avoid CPU profiling overhead)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    environment: process.env.NODE_ENV || 'development',
  });
}

// Create Fastify server with Cloudflare-matched keep-alive timeouts & proxy trust
const app = fastify({ 
  logger: loggerConfig,
  trustProxy: true,            // Extracts real client IP from Cloudflare/Nginx X-Forwarded-For
  bodyLimit: 50 * 1024 * 1024, // 50MB limit to handle large base64 template images
  keepAliveTimeout: 65000,     // 65s (Cloudflare upstream timeout is 60s)
  headersTimeout: 66000,       // Must be > keepAliveTimeout
});

// Support application/x-www-form-urlencoded (for Razorpay payment gateway callbacks)
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, querystring.parse(body));
  } catch (err) {
    done(err, undefined);
  }
});

// Register Brotli & Gzip Response Compression
await app.register(fastifyCompress, {
  global: true,
  encodings: ['br', 'gzip', 'deflate'],
  threshold: 1024,
});

// Register Global Rate Limiting (120 req/min per IP; Puppeteer endpoints have custom 15/min limit)
await app.register(fastifyRateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', 'localhost'],
  errorResponseBuilder: (request, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Please wait ${Math.round(context.ttl / 1000)}s before trying again.`,
  }),
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

// Graceful Process Lifecycle & Zombie Process Prevention
const gracefulShutdown = async (signal) => {
  console.log(`[Server] Received ${signal}. Initiating graceful shutdown...`);
  try {
    await app.close();
    console.log('[Server] Fastify HTTP listener closed.');
    await closeChromiumBrowser();
    console.log('[Server] Chromium browser instance cleanly terminated.');
    await prisma.$disconnect().catch(() => {});
    console.log('[Server] PostgreSQL connection pool disconnected.');
    if (redis && redis.status === 'ready') {
      await redis.quit().catch(() => {});
      console.log('[Server] Redis connection closed.');
    }
    process.exit(0);
  } catch (err) {
    console.error('[Server] Error during graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

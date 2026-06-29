import Redis from 'ioredis';
import dotenv from 'dotenv';
import { loggerConfig } from './logger.js';
import pino from 'pino';

dotenv.config();

const logger = pino(loggerConfig);

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export let redis = null;

const memoryCache = new Map();

try {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) {
        logger.warn('Redis retry limit reached. Disabling Redis for this session.');
        return null; // Stop retrying
      }
      return Math.min(times * 50, 2000); // Backoff
    }
  });

  redis.on('error', (err) => {
    logger.error('Redis connection error: ' + err.message);
  });

  redis.on('connect', () => {
    logger.info('Successfully connected to Redis Server!');
  });

  // Wrap redis.del to automatically invalidate L1 memory cache too
  const originalDel = redis.del.bind(redis);
  redis.del = async function(args, ...moreArgs) {
    let keysToDel = [];
    if (Array.isArray(args)) {
      keysToDel = args;
    } else if (typeof args === 'string') {
      keysToDel = [args, ...moreArgs];
    }
    keysToDel.forEach((key) => {
      memoryCache.delete(key);
      logger.info(`L1 Memory Cache invalidated/cleared for key: ${key}`);
    });
    return originalDel(args, ...moreArgs);
  };
} catch (e) {
  logger.error('Failed to initialize Redis client: ' + e.message);
}

export async function getCachedOrFetch(key, ttlSeconds, fetchFn) {
  // 1. Check L1 Memory Cache
  if (memoryCache.has(key)) {
    const entry = memoryCache.get(key);
    if (Date.now() < entry.expiry) {
      logger.info(`L1 Memory Cache HIT for key: ${key}`);
      return entry.value;
    } else {
      memoryCache.delete(key);
      logger.info(`L1 Memory Cache expired for key: ${key}`);
    }
  }

  // 2. Check L2 Redis Cache
  if (redis && redis.status === 'ready') {
    try {
      const cached = await redis.get(key);
      if (cached) {
        logger.info(`L2 Redis Cache HIT for key: ${key}`);
        const parsed = JSON.parse(cached);
        // Populate L1 Cache
        memoryCache.set(key, {
          value: parsed,
          expiry: Date.now() + ttlSeconds * 1000
        });
        return parsed;
      }
    } catch (err) {
      logger.warn(`Redis get cache failed for key ${key}: ` + err.message);
    }
  }

  // 3. Database Fetch (Cache Miss)
  logger.info(`Cache MISS for key: ${key}. Fetching fresh data…`);
  const result = await fetchFn();

  if (result !== null && result !== undefined) {
    // Populate L1 Cache
    memoryCache.set(key, {
      value: result,
      expiry: Date.now() + ttlSeconds * 1000
    });

    // Populate L2 Redis Cache
    if (redis && redis.status === 'ready') {
      try {
        await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
      } catch (err) {
        logger.warn(`Redis set cache failed for key ${key}: ` + err.message);
      }
    }
  }

  return result;
}

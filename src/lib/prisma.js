import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  max: 10,
  keepAlive: true,
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function withRetry(fn, retries = 3, delayMs = 300) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isConnectionClosed =
        err?.code === 'P1017' ||
        err?.message?.includes('ConnectionClosed') ||
        err?.message?.includes('Server has closed the connection');

      if (isConnectionClosed && attempt < retries) {
        console.warn(`[prisma] Connection closed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms…`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry exhausted all attempts');
}

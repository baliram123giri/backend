import { prisma, withRetry } from '../lib/prisma.js';

let isTableInitialized = false;

/**
 * Ensure the marketing_activity_stats table exists in PostgreSQL.
 */
export async function ensureMarketingStatsTable() {
  if (isTableInitialized) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS marketing_activity_stats (
        id VARCHAR(50) PRIMARY KEY DEFAULT 'global',
        date VARCHAR(10) NOT NULL,
        today_count INT NOT NULL DEFAULT 18,
        total_count INT NOT NULL DEFAULT 12450,
        last_increment_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO marketing_activity_stats (id, date, today_count, total_count, last_increment_at, created_at, updated_at)
      VALUES (
        'global',
        TO_CHAR(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
        18,
        12480,
        NOW(),
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO NOTHING;
    `);
    isTableInitialized = true;
  } catch (err) {
    console.error('[marketingStatsService] Failed to initialize table:', err.message);
  }
}

/**
 * Fetch current marketing stats from PostgreSQL.
 * All periodic organic increments are handled natively by pg_cron in the database.
 */
export async function getMarketingActivityStats() {
  await ensureMarketingStatsTable();

  try {
    const rows = await withRetry(async () => {
      return await prisma.$queryRawUnsafe(
        `SELECT id, date, today_count, total_count FROM marketing_activity_stats WHERE id = 'global' LIMIT 1;`
      );
    });

    if (!rows || rows.length === 0) {
      return {
        success: true,
        todayCount: 18,
        totalCount: 12480,
        formattedToday: '18',
        formattedTotal: '12,480',
      };
    }

    const current = rows[0];
    const todayCount = Number(current.today_count) || 0;
    const totalCount = Number(current.total_count) || 0;

    return {
      success: true,
      todayCount,
      totalCount,
      formattedToday: todayCount.toLocaleString('en-IN'),
      formattedTotal: totalCount.toLocaleString('en-IN'),
    };
  } catch (err) {
    console.error('[marketingStatsService] Error querying stats:', err.message);
    return {
      success: false,
      todayCount: 0,
      totalCount: 0,
      formattedToday: '0',
      formattedTotal: '0',
    };
  }
}

/**
 * Increment the counter when a user action happens (e.g. download or create).
 */
export async function incrementMarketingStats(amount = 1) {
  await ensureMarketingStatsTable();

  try {
    const delta = Math.max(1, Math.min(3, Number(amount) || 1));
    await prisma.$executeRawUnsafe(
      `UPDATE marketing_activity_stats
       SET today_count = LEAST(196, today_count + $1),
           total_count = total_count + $1,
           last_increment_at = NOW(),
           updated_at = NOW()
       WHERE id = 'global';`,
      delta
    );
    return await getMarketingActivityStats();
  } catch (err) {
    console.error('[marketingStatsService] Error incrementing:', err.message);
    return await getMarketingActivityStats();
  }
}

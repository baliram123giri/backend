import { prisma, withRetry } from '../lib/prisma.js';

let isTableInitialized = false;

/**
 * Ensure the dedicated marketing_activity_stats table exists in PostgreSQL.
 * Completely isolated from core business models (User, Order, Template, etc.).
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
    `);
    isTableInitialized = true;
  } catch (err) {
    console.error('[marketingStatsService] Failed to initialize table:', err.message);
  }
}

/**
 * Returns Indian Standard Time (IST = UTC + 5:30) date information.
 */
function getISTInfo() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffsetMs);

  const yyyy = istTime.getFullYear();
  const mm = String(istTime.getMonth() + 1).padStart(2, '0');
  const dd = String(istTime.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  const fractionalHour = hours + (minutes / 60);

  return { now, istTime, dateStr, hours, minutes, fractionalHour };
}

/**
 * Calculates a natural, organic target count for the current hour in IST.
 * - 00:00 - 06:00: starts ~16, creeps gently to ~25
 * - 06:00 - 12:00: wakes up, climbs ~25 to ~75
 * - 12:00 - 17:00: afternoon flow, climbs ~75 to ~125
 * - 17:00 - 22:00: peak evening matchmaking, climbs ~125 to ~175
 * - 22:00 - 23:59: late night, finishes between 165 - 192 (never exceeding 198)
 */
function getOrganicHourTarget(fractionalHour) {
  let target = 16;
  if (fractionalHour <= 6) {
    target = 16 + fractionalHour * 1.5;
  } else if (fractionalHour <= 12) {
    target = 25 + (fractionalHour - 6) * 8.3;
  } else if (fractionalHour <= 17) {
    target = 75 + (fractionalHour - 12) * 10.0;
  } else if (fractionalHour <= 22) {
    target = 125 + (fractionalHour - 17) * 10.0;
  } else {
    target = 175 + (fractionalHour - 22) * 6.5;
  }
  // Soft jitter to ensure no rigid mathematical curve
  const jitter = Math.sin(fractionalHour * 3.14) * 3;
  return Math.min(194, Math.max(16, Math.round(target + jitter)));
}

/**
 * Get current marketing stats, dynamically advancing the organic counter in PostgreSQL.
 */
export async function getMarketingActivityStats() {
  await ensureMarketingStatsTable();

  const { now, dateStr, fractionalHour } = getISTInfo();
  const hourTarget = getOrganicHourTarget(fractionalHour);

  try {
    const rows = await withRetry(async () => {
      return await prisma.$queryRawUnsafe(
        `SELECT id, date, today_count, total_count, last_increment_at FROM marketing_activity_stats WHERE id = 'global' LIMIT 1;`
      );
    });

    // 1. Initial seed if table has no record yet
    if (!rows || rows.length === 0) {
      const initialToday = Math.min(hourTarget, Math.max(16, hourTarget - Math.floor(Math.random() * 4)));
      const initialTotal = 12480 + Math.floor(Math.random() * 20);

      await prisma.$executeRawUnsafe(
        `INSERT INTO marketing_activity_stats (id, date, today_count, total_count, last_increment_at, created_at, updated_at)
         VALUES ('global', $1, $2, $3, NOW(), NOW(), NOW());`,
        dateStr,
        initialToday,
        initialTotal
      );

      return {
        success: true,
        todayCount: initialToday,
        totalCount: initialTotal,
        recentIncrement: 1,
        formattedToday: initialToday.toLocaleString('en-IN'),
        formattedTotal: initialTotal.toLocaleString('en-IN'),
      };
    }

    const current = rows[0];
    let todayCount = Number(current.today_count) || 16;
    let totalCount = Number(current.total_count) || 12450;
    const lastInc = new Date(current.last_increment_at);
    const elapsedMinutes = (now.getTime() - lastInc.getTime()) / 60000;

    // 2. Day reset (IST midnight crossed)
    if (current.date !== dateStr) {
      const morningBaseline = Math.floor(14 + Math.random() * 5); // 14 to 18
      todayCount = morningBaseline;
      await prisma.$executeRawUnsafe(
        `UPDATE marketing_activity_stats 
         SET date = $1, today_count = $2, last_increment_at = NOW(), updated_at = NOW() 
         WHERE id = 'global';`,
        dateStr,
        todayCount
      );

      return {
        success: true,
        todayCount,
        totalCount,
        recentIncrement: 1,
        formattedToday: todayCount.toLocaleString('en-IN'),
        formattedTotal: totalCount.toLocaleString('en-IN'),
      };
    }

    // 3. Dynamic organic increment:
    // User requested: "happening sometimes 2 in the next 10 minutes, sometimes 5... under 200, 165 till late night"
    let increment = 0;

    // Minimum elapsed threshold (randomized between 2.2 and 4.5 minutes)
    const thresholdMinutes = 2.2 + Math.random() * 2.3;

    if (elapsedMinutes >= thresholdMinutes && todayCount < hourTarget && todayCount < 196) {
      if (elapsedMinutes < 6) {
        // Short gap: +1 or +2
        increment = Math.random() < 0.65 ? 1 : 2;
      } else if (elapsedMinutes < 12) {
        // 6 - 12 min gap: +2, +3, or occasionally +4
        increment = Math.floor(2 + Math.random() * 3);
      } else if (elapsedMinutes < 25) {
        // 12 - 25 min gap: +3, +4, or +5 (matching user's "sometimes 5")
        increment = Math.floor(3 + Math.random() * 3);
      } else {
        // Longer gap: gentle catchup towards target ceiling
        const deficit = hourTarget - todayCount;
        increment = Math.min(deficit, Math.max(2, Math.floor(elapsedMinutes / 5) + Math.floor(Math.random() * 3)));
      }

      // Safeguard: never exceed current hour target ceiling, and never exceed 196
      increment = Math.min(increment, hourTarget - todayCount);
      if (todayCount + increment > 196) {
        increment = Math.max(0, 196 - todayCount);
      }

      if (increment > 0) {
        todayCount += increment;
        totalCount += increment;

        await prisma.$executeRawUnsafe(
          `UPDATE marketing_activity_stats 
           SET today_count = $1, total_count = $2, last_increment_at = NOW(), updated_at = NOW() 
           WHERE id = 'global';`,
          todayCount,
          totalCount
        );
      }
    }

    return {
      success: true,
      todayCount,
      totalCount,
      recentIncrement: increment,
      formattedToday: todayCount.toLocaleString('en-IN'),
      formattedTotal: totalCount.toLocaleString('en-IN'),
    };
  } catch (err) {
    console.error('[marketingStatsService] Error querying/updating stats:', err.message);
    // Graceful fallback to avoid any UI disruption
    const fallbackToday = Math.min(185, Math.max(25, hourTarget));
    const fallbackTotal = 12480;
    return {
      success: true,
      todayCount: fallbackToday,
      totalCount: fallbackTotal,
      recentIncrement: 1,
      formattedToday: fallbackToday.toLocaleString('en-IN'),
      formattedTotal: fallbackTotal.toLocaleString('en-IN'),
    };
  }
}

/**
 * Increment the counter when a real action happens (e.g. download or create).
 */
export async function incrementMarketingStats(amount = 1) {
  await ensureMarketingStatsTable();
  const { dateStr } = getISTInfo();

  try {
    const delta = Math.max(1, Math.min(3, Number(amount) || 1));
    await prisma.$executeRawUnsafe(
      `UPDATE marketing_activity_stats 
       SET today_count = LEAST(196, today_count + $1), 
           total_count = total_count + $1, 
           last_increment_at = NOW(), 
           updated_at = NOW() 
       WHERE id = 'global' AND date = $2;`,
      delta,
      dateStr
    );
    return await getMarketingActivityStats();
  } catch (err) {
    console.error('[marketingStatsService] Error incrementing:', err.message);
    return await getMarketingActivityStats();
  }
}

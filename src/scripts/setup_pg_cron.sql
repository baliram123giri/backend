-- =============================================================================
-- pg_cron Setup: Organic Activity Counter Scheduler
-- =============================================================================
-- Run this file on your VPS PostgreSQL (as superuser/postgres):
--   psql -U postgres -d your_database_name -f setup_pg_cron.sql
--
-- PREREQUISITES (one-time VPS setup):
--   1. Edit /etc/postgresql/*/main/postgresql.conf:
--        shared_preload_libraries = 'pg_cron'
--        cron.database_name = 'your_database_name'   <-- match your DB name
--   2. sudo systemctl restart postgresql
--   3. Then run this file.
-- =============================================================================


-- Step 1: Enable pg_cron extension
-- (Requires superuser. Only needs to run once per database cluster.)
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- Step 2: Ensure the marketing stats table exists
-- (Idempotent — safe to re-run)
CREATE TABLE IF NOT EXISTS marketing_activity_stats (
  id               VARCHAR(50)  PRIMARY KEY DEFAULT 'global',
  date             VARCHAR(10)  NOT NULL,
  today_count      INT          NOT NULL DEFAULT 18,
  total_count      INT          NOT NULL DEFAULT 12450,
  last_increment_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the global row if not already present
INSERT INTO marketing_activity_stats (id, date, today_count, total_count, last_increment_at, created_at, updated_at)
VALUES (
  'global',
  TO_CHAR(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
  18,
  12480,
  NOW() - INTERVAL '20 minutes',  -- ensures first pg_cron tick will trigger an increment
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- Step 3: Create the organic increment PostgreSQL function
--
-- This function is a 1:1 port of the JS logic in marketingStatsService.js:
--   - Reads IST time via 'Asia/Kolkata' timezone (no manual offset needed)
--   - Calculates hour target using the same piecewise curve + sine jitter
--   - Applies randomized threshold check (2.2 - 4.5 min)
--   - Uses ATOMIC UPDATE with threshold re-check in WHERE clause
--   - Handles midnight day-reset
--   - Never exceeds 196 or the hourly ceiling
-- =============================================================================
CREATE OR REPLACE FUNCTION increment_marketing_stats_organic()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_ist_time          TIMESTAMPTZ;
  v_fractional_hour   NUMERIC;
  v_date_str          VARCHAR(10);
  v_target            NUMERIC;
  v_jitter            NUMERIC;
  v_hour_target       INT;
  v_current_date      VARCHAR(10);
  v_today_count       INT;
  v_total_count       BIGINT;
  v_elapsed_minutes   NUMERIC;
  v_threshold_minutes NUMERIC;
  v_increment         INT;
  v_rows_updated      INT;
BEGIN

  -- ── IST time & date ──────────────────────────────────────────────────────
  v_ist_time        := NOW() AT TIME ZONE 'Asia/Kolkata';
  v_fractional_hour := EXTRACT(HOUR   FROM v_ist_time)
                     + EXTRACT(MINUTE FROM v_ist_time) / 60.0;
  v_date_str        := TO_CHAR(v_ist_time, 'YYYY-MM-DD');

  -- ── Organic hour target (mirrors JS getOrganicHourTarget) ────────────────
  IF    v_fractional_hour <= 6  THEN v_target := 16  + v_fractional_hour         * 1.5;
  ELSIF v_fractional_hour <= 12 THEN v_target := 25  + (v_fractional_hour -  6)  * 8.3;
  ELSIF v_fractional_hour <= 17 THEN v_target := 75  + (v_fractional_hour - 12)  * 10.0;
  ELSIF v_fractional_hour <= 22 THEN v_target := 125 + (v_fractional_hour - 17)  * 10.0;
  ELSE                               v_target := 175 + (v_fractional_hour - 22)  * 6.5;
  END IF;

  -- Sine jitter for natural curve irregularity
  v_jitter      := SIN(v_fractional_hour * 3.14159) * 3;
  v_hour_target := LEAST(194, GREATEST(16, ROUND(v_target + v_jitter)::INT));

  -- ── Read current DB row ──────────────────────────────────────────────────
  SELECT
    date,
    today_count,
    total_count,
    EXTRACT(EPOCH FROM (NOW() - last_increment_at)) / 60.0
  INTO
    v_current_date,
    v_today_count,
    v_total_count,
    v_elapsed_minutes
  FROM marketing_activity_stats
  WHERE id = 'global';

  -- Row not found — nothing to do (Node.js boot handles initial seed)
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- ── Midnight day-reset (IST) ──────────────────────────────────────────────
  IF v_current_date IS DISTINCT FROM v_date_str THEN
    UPDATE marketing_activity_stats
    SET date              = v_date_str,
        today_count       = 14 + FLOOR(RANDOM() * 5)::INT,  -- 14-18 morning baseline
        last_increment_at = NOW(),
        updated_at        = NOW()
    WHERE id = 'global';
    RAISE LOG '[pg_cron:stats] Day reset to %', v_date_str;
    RETURN;
  END IF;

  -- ── Already at ceiling — skip ─────────────────────────────────────────────
  IF v_today_count >= v_hour_target OR v_today_count >= 196 THEN
    RAISE LOG '[pg_cron:stats] At ceiling (today=%, target=%) — skipping', v_today_count, v_hour_target;
    RETURN;
  END IF;

  -- ── Randomized elapsed-time threshold (2.2 – 4.5 min) ───────────────────
  v_threshold_minutes := 2.2 + RANDOM() * 2.3;

  IF v_elapsed_minutes < v_threshold_minutes THEN
    RAISE LOG '[pg_cron:stats] Threshold not met (elapsed=%.1f min, need=%.1f min)', v_elapsed_minutes, v_threshold_minutes;
    RETURN;
  END IF;

  -- ── Calculate increment based on elapsed time ─────────────────────────────
  IF    v_elapsed_minutes < 6  THEN
    v_increment := CASE WHEN RANDOM() < 0.65 THEN 1 ELSE 2 END;
  ELSIF v_elapsed_minutes < 12 THEN
    v_increment := 2 + FLOOR(RANDOM() * 3)::INT;
  ELSIF v_elapsed_minutes < 25 THEN
    v_increment := 3 + FLOOR(RANDOM() * 3)::INT;
  ELSE
    -- Longer gap: gentle catchup towards ceiling
    v_increment := LEAST(
      v_hour_target - v_today_count,
      GREATEST(2, FLOOR(v_elapsed_minutes / 5)::INT + FLOOR(RANDOM() * 3)::INT)
    );
  END IF;

  -- Safeguard: respect hour target ceiling and hard 196 cap
  v_increment := LEAST(v_increment, v_hour_target - v_today_count);
  IF v_today_count + v_increment > 196 THEN
    v_increment := GREATEST(0, 196 - v_today_count);
  END IF;

  IF v_increment <= 0 THEN
    RETURN;
  END IF;

  -- ── ATOMIC UPDATE (race-safe) ─────────────────────────────────────────────
  -- The elapsed-time check is INSIDE the WHERE clause so two concurrent
  -- pg_cron executions cannot both win — only one updates, the other gets 0 rows.
  UPDATE marketing_activity_stats
  SET today_count       = LEAST(196, today_count + v_increment),
      total_count       = total_count + v_increment,
      last_increment_at = NOW(),
      updated_at        = NOW()
  WHERE id = 'global'
    AND date = v_date_str
    AND EXTRACT(EPOCH FROM (NOW() - last_increment_at)) / 60.0 >= v_threshold_minutes
    AND today_count < v_hour_target;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated > 0 THEN
    RAISE LOG '[pg_cron:stats] Incremented +% | today=%, total=%',
      v_increment, v_today_count + v_increment, v_total_count + v_increment;
  ELSE
    RAISE LOG '[pg_cron:stats] Lost race condition — another process updated first';
  END IF;

END;
$$;


-- =============================================================================
-- Step 4: Schedule the function via pg_cron
--
-- Runs every 10 minutes, 24/7, entirely inside PostgreSQL.
-- No Node.js process required. Survives app restarts, VPS reboots, deployments.
-- =============================================================================

-- Remove any previous schedule with this name (safe to re-run)
SELECT cron.unschedule('organic-stats-increment')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'organic-stats-increment'
);

-- Schedule: every 10 minutes
SELECT cron.schedule(
  'organic-stats-increment',     -- unique job name
  '*/10 * * * *',                -- every 10 minutes (pg_cron minimum is 1 min)
  'SELECT increment_marketing_stats_organic();'
);

-- Grant permissions to application user (baliram)
GRANT USAGE ON SCHEMA cron TO baliram;
GRANT ALL ON ALL TABLES IN SCHEMA cron TO baliram;
GRANT ALL ON ALL SEQUENCES IN SCHEMA cron TO baliram;
GRANT ALL ON TABLE marketing_activity_stats TO baliram;
GRANT EXECUTE ON FUNCTION increment_marketing_stats_organic() TO baliram;


-- =============================================================================
-- Step 5: Verify setup
-- =============================================================================
SELECT
  jobid,
  jobname,
  schedule,
  command,
  active
FROM cron.job
WHERE jobname = 'organic-stats-increment';

-- View recent execution history:
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'organic-stats-increment') ORDER BY start_time DESC LIMIT 20;

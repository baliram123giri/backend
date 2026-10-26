// READ-ONLY admin analytics endpoints. No writes, no schema changes.
// All time bucketing is done in IST (Asia/Kolkata, UTC+05:30) - the app's business timezone.
// Prisma stores DateTime as `timestamp` (UTC, no tz), so we convert with
//   ("col" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'
import { Readable } from 'stream';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getCachedOrFetch } from '../../lib/redis.js';

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 365;
const DEFAULT_RANGE_DAYS = 30;
const CACHE_TTL = 60; // seconds
const EXPORT_MAX_ROWS = 50000;

const INTERVALS = ['day', 'week', 'month'];
const METRICS = ['revenue', 'orders', 'users', 'downloads'];

class BadRequest extends Error {}

// ---------- date helpers (IST aware) ----------
function parseDateParam(val, isEnd) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val !== 'string' || val.length > 40) throw new BadRequest('Invalid date parameter');
  const trimmed = val.trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Date-only: interpret as an IST calendar day (start or end of that day)
    d = new Date(`${trimmed}T${isEnd ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  } else {
    d = new Date(trimmed);
  }
  if (isNaN(d.getTime())) throw new BadRequest('Invalid date parameter');
  return d;
}

function istStartOfDay(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

function resolveRange(query) {
  let to = parseDateParam(query.to, true) || new Date();
  let from = parseDateParam(query.from, false);
  if (!from) from = istStartOfDay(new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS));
  if (from > to) throw new BadRequest('`from` must be before `to`');
  let capped = false;
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    from = istStartOfDay(new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS));
    capped = true;
  }
  const span = to.getTime() - from.getTime() + 1;
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(from.getTime() - span);
  return { from, to, prevFrom, prevTo, capped };
}

// IST calendar key helpers for gap filling
function istParts(date) {
  const s = new Date(date.getTime() + IST_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), dow: s.getUTCDay() };
}
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

function bucketKeys(from, to, interval) {
  const { y, m, d, dow } = istParts(from);
  // cursor is a UTC-midnight Date representing the IST calendar date
  let cur;
  if (interval === 'month') cur = new Date(Date.UTC(y, m, 1));
  else if (interval === 'week') cur = new Date(Date.UTC(y, m, d - ((dow + 6) % 7))); // ISO Monday
  else cur = new Date(Date.UTC(y, m, d));
  const end = istParts(to);
  const endMs = Date.UTC(end.y, end.m, end.d);
  const keys = [];
  while (cur.getTime() <= endMs && keys.length < 1000) {
    keys.push(keyOf(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate()));
    if (interval === 'month') cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    else cur = new Date(cur.getTime() + (interval === 'week' ? 7 : 1) * DAY_MS);
  }
  return keys;
}

// SQL fragment: IST-local timestamp of a column. `col` must be a trusted literal.
const ist = (col) => Prisma.raw(`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')`);
const trunc = (interval, col) => Prisma.raw(`date_trunc('${interval}', ((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'))`);

// ---------- misc helpers ----------
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v) => Math.round(num(v) * 100) / 100;

function delta(cur, prev) {
  cur = num(cur); prev = num(prev);
  let pct;
  if (prev === 0) pct = cur === 0 ? 0 : null; // null = no baseline (infinite growth)
  else pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  return { current: cur, previous: prev, change: round2(cur - prev), deltaPct: pct };
}

function pickEnum(val, allowed, def) {
  if (val === undefined || val === '') return def;
  if (!allowed.includes(val)) throw new BadRequest(`Invalid value "${val}". Allowed: ${allowed.join(', ')}`);
  return val;
}

function pickInt(val, def, min, max) {
  if (val === undefined || val === '') return def;
  const n = Number(val);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`Integer between ${min} and ${max} expected`);
  return n;
}

// Runs a sub-query; on failure records a warning and returns the fallback.
function makeSafe(warnings, log) {
  return async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push({ section: name, error: 'query_failed' });
      log?.error?.(`Analytics sub-query "${name}" failed: ${err.message}`);
      return fallback;
    }
  };
}

function rangeMeta(r) {
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    previousFrom: r.prevFrom.toISOString(),
    previousTo: r.prevTo.toISOString(),
    timezone: 'Asia/Kolkata',
    capped: r.capped
  };
}

function cached(name, request, range, extra, fn) {
  const key = `admin:analytics:${name}:${range.from.getTime()}:${range.to.getTime()}:${extra}`;
  return getCachedOrFetch(key, CACHE_TTL, fn);
}

function handle(app, handler) {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (err instanceof BadRequest) return reply.status(400).send({ success: false, error: err.message });
      app.log.error(`Analytics error: ${err.message}`);
      return reply.status(500).send({ success: false, error: 'Failed to compute analytics' });
    }
  };
}

// ---------- CSV ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const EXPORTS = {
  orders: {
    model: 'order',
    cols: ['id', 'razorpayOrderId', 'razorpayPaymentId', 'amount', 'currency', 'status', 'format', 'templateId',
      'customerName', 'customerEmail', 'customerPhone', 'couponCode', 'discountApplied', 'downloadStatus',
      'referralCode', 'createdAt']
  },
  users: {
    model: 'user',
    cols: ['id', 'name', 'email', 'role', 'status', 'createdAt']
  },
  downloads: {
    model: 'downloadLog',
    cols: ['id', 'name', 'location', 'format', 'templateId', 'orderId', 'errorMsg', 'createdAt']
  }
};

export default async function analyticsRoutes(app, options) {
  // ================= OVERVIEW =================
  app.get('/analytics/overview', handle(app, async (request) => {
    const r = resolveRange(request.query);
    return cached('overview', request, r, '', async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);

      const orderAgg = (a, b) => prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS "total",
          COUNT(CASE WHEN status = 'paid' THEN 1 END)::int AS "paid",
          COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0)::float AS "revenue"
        FROM "Order" WHERE "createdAt" >= ${a} AND "createdAt" <= ${b}`;
      const countUsers = (a, b) => prisma.user.count({ where: { createdAt: { gte: a, lte: b } } });
      const countDl = (a, b) => prisma.downloadLog.count({ where: { createdAt: { gte: a, lte: b }, errorMsg: null } });

      const emptyO = [{ total: 0, paid: 0, revenue: 0 }];
      const [oc, op, uc, up, dc, dp] = await Promise.all([
        safe('orders_current', () => orderAgg(r.from, r.to), emptyO),
        safe('orders_previous', () => orderAgg(r.prevFrom, r.prevTo), emptyO),
        safe('users_current', () => countUsers(r.from, r.to), 0),
        safe('users_previous', () => countUsers(r.prevFrom, r.prevTo), 0),
        safe('downloads_current', () => countDl(r.from, r.to), 0),
        safe('downloads_previous', () => countDl(r.prevFrom, r.prevTo), 0)
      ]);
      const c = oc[0] || {}; const p = op[0] || {};
      const conv = (o) => (num(o.total) > 0 ? Math.round((num(o.paid) / num(o.total)) * 1000) / 10 : 0);
      const aov = (o) => (num(o.paid) > 0 ? round2(num(o.revenue) / num(o.paid)) : 0);

      return {
        success: true,
        range: rangeMeta(r),
        warnings,
        revenue: delta(round2(c.revenue), round2(p.revenue)),
        orders: delta(c.total, p.total),
        paidOrders: delta(c.paid, p.paid),
        conversionRate: delta(conv(c), conv(p)), // percent of created orders that became paid
        averageOrderValue: delta(aov(c), aov(p)),
        newUsers: delta(uc, up),
        downloads: delta(dc, dp) // successful downloads (errorMsg IS NULL), paid + free
      };
    });
  }));

  // ================= TIMESERIES =================
  app.get('/analytics/timeseries', handle(app, async (request) => {
    const r = resolveRange(request.query);
    const metric = pickEnum(request.query.metric, METRICS, 'revenue');
    const interval = pickEnum(request.query.interval, INTERVALS, 'day');
    return cached('timeseries', request, r, `${metric}:${interval}`, async () => {
      let rows;
      if (metric === 'revenue') {
        rows = await prisma.$queryRaw`
          SELECT to_char(${trunc(interval, '"createdAt"')}, 'YYYY-MM-DD') AS bucket,
                 COALESCE(SUM(amount), 0)::float AS value
          FROM "Order" WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1`;
      } else if (metric === 'orders') {
        rows = await prisma.$queryRaw`
          SELECT to_char(${trunc(interval, '"createdAt"')}, 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS value
          FROM "Order" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1`;
      } else if (metric === 'users') {
        rows = await prisma.$queryRaw`
          SELECT to_char(${trunc(interval, '"createdAt"')}, 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS value
          FROM "User" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1`;
      } else {
        rows = await prisma.$queryRaw`
          SELECT to_char(${trunc(interval, '"createdAt"')}, 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS value
          FROM "DownloadLog" WHERE "errorMsg" IS NULL AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1`;
      }
      const map = new Map(rows.map((x) => [x.bucket, num(x.value)]));
      const series = bucketKeys(r.from, r.to, interval).map((k) => ({
        date: k, value: metric === 'revenue' ? round2(map.get(k) || 0) : (map.get(k) || 0)
      }));
      const total = series.reduce((s, x) => s + x.value, 0);
      return { success: true, range: rangeMeta(r), metric, interval, total: round2(total), series };
    });
  }));

  // ================= REVENUE BREAKDOWN =================
  app.get('/analytics/revenue-breakdown', handle(app, async (request) => {
    const r = resolveRange(request.query);
    return cached('revenue-breakdown', request, r, '', async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);

      const [byTemplate, byCoupon, byStatus, byFormat, heat] = await Promise.all([
        safe('by_template', () => prisma.$queryRaw`
          SELECT o."templateId" AS "templateId", t.name AS "templateName",
                 COUNT(*)::int AS "paidOrders", COALESCE(SUM(o.amount), 0)::float AS revenue
          FROM "Order" o LEFT JOIN "Template" t ON t.id = o."templateId"
          WHERE o.status = 'paid' AND o."createdAt" >= ${r.from} AND o."createdAt" <= ${r.to}
          GROUP BY o."templateId", t.name ORDER BY revenue DESC LIMIT 50`, []),
        safe('by_coupon', () => prisma.$queryRaw`
          SELECT UPPER(NULLIF(TRIM("couponCode"), '')) AS code,
                 COUNT(*)::int AS "paidOrders", COALESCE(SUM(amount), 0)::float AS revenue,
                 COALESCE(SUM("discountApplied"), 0)::float AS "discountGiven"
          FROM "Order"
          WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1 ORDER BY revenue DESC LIMIT 100`, []),
        safe('by_status', () => prisma.$queryRaw`
          SELECT status, COUNT(*)::int AS orders, COALESCE(SUM(amount), 0)::float AS amount
          FROM "Order" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY status ORDER BY orders DESC`, []),
        safe('by_format', () => prisma.$queryRaw`
          SELECT format, COUNT(*)::int AS "paidOrders", COALESCE(SUM(amount), 0)::float AS revenue
          FROM "Order" WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY format ORDER BY revenue DESC`, []),
        safe('heatmap', () => prisma.$queryRaw`
          SELECT EXTRACT(DOW FROM ${ist('"createdAt"')})::int AS dow,
                 EXTRACT(HOUR FROM ${ist('"createdAt"')})::int AS hour,
                 COUNT(*)::int AS "paidOrders", COALESCE(SUM(amount), 0)::float AS revenue
          FROM "Order" WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1, 2`, [])
      ]);

      const withCode = byCoupon.filter((x) => x.code);
      const without = byCoupon.find((x) => !x.code) || { paidOrders: 0, revenue: 0, discountGiven: 0 };
      const sum = (arr, k) => arr.reduce((s, x) => s + num(x[k]), 0);

      // 7 x 24 grid, dow 0=Sunday, hours in IST
      const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ paidOrders: 0, revenue: 0 })));
      for (const h of heat) {
        if (grid[h.dow]?.[h.hour]) grid[h.dow][h.hour] = { paidOrders: num(h.paidOrders), revenue: round2(h.revenue) };
      }

      return {
        success: true,
        range: rangeMeta(r),
        warnings,
        byTemplate: byTemplate.map((x) => ({
          templateId: x.templateId, templateName: x.templateName || '(deleted/unknown)',
          paidOrders: num(x.paidOrders), revenue: round2(x.revenue)
        })),
        byCoupon: {
          withCoupon: { paidOrders: sum(withCode, 'paidOrders'), revenue: round2(sum(withCode, 'revenue')), discountGiven: round2(sum(withCode, 'discountGiven')) },
          withoutCoupon: { paidOrders: num(without.paidOrders), revenue: round2(without.revenue) },
          codes: withCode.map((x) => ({ code: x.code, paidOrders: num(x.paidOrders), revenue: round2(x.revenue), discountGiven: round2(x.discountGiven) }))
        },
        byStatus: byStatus.map((x) => ({ status: x.status, orders: num(x.orders), amount: round2(x.amount) })),
        byFormat: byFormat.map((x) => ({ format: x.format, paidOrders: num(x.paidOrders), revenue: round2(x.revenue) })),
        heatmap: { timezone: 'Asia/Kolkata', dowLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], grid }
      };
    });
  }));

  // ================= TOP TEMPLATES =================
  app.get('/analytics/top-templates', handle(app, async (request) => {
    const r = resolveRange(request.query);
    const sort = pickEnum(request.query.sort, ['downloads', 'revenue'], 'downloads');
    const limit = pickInt(request.query.limit, 10, 1, 50);
    return cached('top-templates', request, r, `${sort}:${limit}`, async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);
      const [dl, rev, templates] = await Promise.all([
        safe('downloads', () => prisma.$queryRaw`
          SELECT "templateId", COUNT(*)::int AS downloads,
                 COUNT(CASE WHEN "orderId" IS NULL THEN 1 END)::int AS "freeDownloads",
                 COUNT(CASE WHEN "orderId" IS NOT NULL THEN 1 END)::int AS "paidDownloads"
          FROM "DownloadLog"
          WHERE "errorMsg" IS NULL AND "templateId" IS NOT NULL AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY "templateId"`, []),
        safe('revenue', () => prisma.$queryRaw`
          SELECT "templateId", COUNT(*)::int AS "paidOrders", COALESCE(SUM(amount), 0)::float AS revenue
          FROM "Order" WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY "templateId"`, []),
        safe('templates', () => prisma.template.findMany({ select: { id: true, name: true } }), [])
      ]);
      const names = new Map(templates.map((t) => [t.id, t.name]));
      const m = new Map();
      const get = (id) => {
        if (!m.has(id)) m.set(id, { templateId: id, templateName: names.get(id) || '(deleted/unknown)', downloads: 0, freeDownloads: 0, paidDownloads: 0, paidOrders: 0, revenue: 0 });
        return m.get(id);
      };
      dl.forEach((x) => Object.assign(get(x.templateId), { downloads: num(x.downloads), freeDownloads: num(x.freeDownloads), paidDownloads: num(x.paidDownloads) }));
      rev.forEach((x) => Object.assign(get(x.templateId), { paidOrders: num(x.paidOrders), revenue: round2(x.revenue) }));
      const items = [...m.values()].sort((a, b) => (b[sort] - a[sort]) || (b.revenue - a.revenue) || (b.downloads - a.downloads)).slice(0, limit);
      return { success: true, range: rangeMeta(r), warnings, sort, limit, templates: items };
    });
  }));

  // ================= FUNNEL =================
  app.get('/analytics/funnel', handle(app, async (request) => {
    const r = resolveRange(request.query);
    return cached('funnel', request, r, '', async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);
      const [o, dlStatus, freeDl, clicks] = await Promise.all([
        safe('orders', () => prisma.$queryRaw`
          SELECT COUNT(*)::int AS created,
                 COUNT(CASE WHEN status = 'paid' THEN 1 END)::int AS paid,
                 COUNT(CASE WHEN status = 'paid' AND ("downloadStatus" = 'success' OR EXISTS (
                   SELECT 1 FROM "DownloadLog" d WHERE d."orderId" = "Order"."razorpayOrderId" AND d."errorMsg" IS NULL
                 )) THEN 1 END)::int AS "paidAndDownloaded",
                 COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS "paymentFailed",
                 COUNT(CASE WHEN status = 'paid' AND ("downloadStatus" = 'failed') THEN 1 END)::int AS "paidDownloadFailed"
          FROM "Order" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}`, [{}]),
        safe('download_status', () => prisma.$queryRaw`
          SELECT COALESCE("downloadStatus", '(none)') AS status, COUNT(*)::int AS orders
          FROM "Order" WHERE status = 'paid' AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}
          GROUP BY 1`, []),
        safe('free_downloads', () => prisma.downloadLog.count({
          where: { orderId: null, errorMsg: null, createdAt: { gte: r.from, lte: r.to } }
        }), 0),
        safe('referral_clicks', () => prisma.referralClick.count({ where: { createdAt: { gte: r.from, lte: r.to } } }), 0)
      ]);
      const x = o[0] || {};
      const created = num(x.created), paid = num(x.paid), dled = num(x.paidAndDownloaded);
      const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
      return {
        success: true,
        range: rangeMeta(r),
        warnings,
        note: 'No preview/view events are stored in the database, so the funnel starts at order creation (checkout initiated). Free downloads (no order) are reported separately.',
        steps: [
          { key: 'orderCreated', label: 'Order created (checkout started)', count: created, pctOfPrevious: 100, pctOfFirst: 100 },
          { key: 'paid', label: 'Paid', count: paid, pctOfPrevious: pct(paid, created), pctOfFirst: pct(paid, created) },
          { key: 'downloaded', label: 'Downloaded successfully', count: dled, pctOfPrevious: pct(dled, paid), pctOfFirst: pct(dled, created) }
        ],
        dropOffs: { paymentFailedOrAbandoned: Math.max(created - paid, 0), paymentFailedStatus: num(x.paymentFailed), paidButNoSuccessfulDownload: Math.max(paid - dled, 0), paidDownloadFailed: num(x.paidDownloadFailed) },
        paidOrdersByDownloadStatus: dlStatus.map((d) => ({ status: d.status, orders: num(d.orders) })),
        freeDownloads: freeDl,
        referralClicks: clicks
      };
    });
  }));

  // ================= AFFILIATES =================
  app.get('/analytics/affiliates', handle(app, async (request) => {
    const r = resolveRange(request.query);
    const limit = pickInt(request.query.limit, 10, 1, 50);
    return cached('affiliates', request, r, `${limit}`, async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);
      const inRange = { gte: r.from, lte: r.to };
      const [clicks, uniq, signups, signupsByStatus, comm, referredOrders, pendingW, unpaidC, top] = await Promise.all([
        safe('clicks', () => prisma.referralClick.count({ where: { createdAt: inRange } }), 0),
        safe('unique_visitors', () => prisma.$queryRaw`
          SELECT COUNT(DISTINCT COALESCE("cookieId", "ipAddress"))::int AS n FROM "ReferralClick"
          WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}`, [{ n: 0 }]),
        safe('signups', () => prisma.affiliate.count({ where: { createdAt: inRange } }), 0),
        safe('signups_by_status', () => prisma.affiliate.groupBy({ by: ['status'], where: { createdAt: inRange }, _count: { _all: true } }), []),
        safe('commissions', () => prisma.$queryRaw`
          SELECT status, COUNT(*)::int AS n, COALESCE(SUM("commissionAmount"), 0)::float AS commission,
                 COALESCE(SUM("orderAmount"), 0)::float AS "orderAmount"
          FROM "Commission" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to} GROUP BY status`, []),
        safe('referred_orders', () => prisma.$queryRaw`
          SELECT COUNT(*)::int AS orders, COALESCE(SUM(amount), 0)::float AS revenue FROM "Order"
          WHERE status = 'paid' AND "referralCode" IS NOT NULL AND "createdAt" >= ${r.from} AND "createdAt" <= ${r.to}`, [{ orders: 0, revenue: 0 }]),
        // snapshots (not range-bound): money currently owed
        safe('pending_withdrawals', () => prisma.withdrawal.aggregate({ where: { status: 'pending' }, _count: { _all: true }, _sum: { amount: true } }), { _count: { _all: 0 }, _sum: { amount: 0 } }),
        safe('unpaid_commissions', () => prisma.commission.groupBy({ by: ['status'], where: { status: { in: ['pending', 'approved'] } }, _count: { _all: true }, _sum: { commissionAmount: true } }), []),
        safe('top_affiliates', () => prisma.$queryRaw`
          SELECT a.id, a.name, a.code, a.tier, a.status,
                 COUNT(c.id)::int AS conversions,
                 COALESCE(SUM(c."orderAmount"), 0)::float AS "orderAmount",
                 COALESCE(SUM(c."commissionAmount"), 0)::float AS commission,
                 (SELECT COUNT(*)::int FROM "ReferralClick" rc WHERE rc."affiliateId" = a.id
                    AND rc."createdAt" >= ${r.from} AND rc."createdAt" <= ${r.to}) AS clicks
          FROM "Affiliate" a JOIN "Commission" c ON c."affiliateId" = a.id
          WHERE c."createdAt" >= ${r.from} AND c."createdAt" <= ${r.to} AND c.status <> 'rejected'
          GROUP BY a.id ORDER BY commission DESC LIMIT ${limit}`, [])
      ]);
      const commByStatus = {};
      let convTotal = 0, commTotal = 0;
      comm.forEach((c) => {
        commByStatus[c.status] = { count: num(c.n), commission: round2(c.commission), orderAmount: round2(c.orderAmount) };
        if (c.status !== 'rejected') { convTotal += num(c.n); commTotal += num(c.commission); }
      });
      const pw = pendingW || {};
      return {
        success: true,
        range: rangeMeta(r),
        warnings,
        clicks,
        uniqueVisitors: num(uniq[0]?.n),
        signups,
        signupsByStatus: Object.fromEntries(signupsByStatus.map((s) => [s.status, s._count._all])),
        conversions: convTotal, // non-rejected commissions created in range (1 per referred paid order)
        clickToConversionRate: clicks > 0 ? Math.round((convTotal / clicks) * 1000) / 10 : 0,
        referredPaidOrders: { orders: num(referredOrders[0]?.orders), revenue: round2(referredOrders[0]?.revenue) },
        commissions: { totalEarned: round2(commTotal), byStatus: commByStatus },
        payoutsPending: {
          // snapshot as of now, independent of date range
          withdrawalRequests: { count: pw._count?._all || 0, amount: round2(pw._sum?.amount) },
          unpaidCommissions: Object.fromEntries(unpaidC.map((u) => [u.status, { count: u._count._all, amount: round2(u._sum.commissionAmount) }]))
        },
        topAffiliates: top.map((t) => ({ ...t, orderAmount: round2(t.orderAmount), commission: round2(t.commission), conversions: num(t.conversions), clicks: num(t.clicks) }))
      };
    });
  }));

  // ================= FEEDBACK =================
  app.get('/analytics/feedback', handle(app, async (request) => {
    const r = resolveRange(request.query);
    const interval = pickEnum(request.query.interval, INTERVALS, 'day');
    return cached('feedback', request, r, interval, async () => {
      const warnings = [];
      const safe = makeSafe(warnings, app.log);
      const [dist, prevAgg, trend] = await Promise.all([
        safe('distribution', () => prisma.feedback.groupBy({ by: ['rating'], where: { createdAt: { gte: r.from, lte: r.to } }, _count: { _all: true } }), []),
        safe('previous', () => prisma.feedback.aggregate({ where: { createdAt: { gte: r.prevFrom, lte: r.prevTo } }, _count: { _all: true }, _avg: { rating: true } }), { _count: { _all: 0 }, _avg: { rating: null } }),
        safe('trend', () => prisma.$queryRaw`
          SELECT to_char(${trunc(interval, '"createdAt"')}, 'YYYY-MM-DD') AS bucket,
                 COUNT(*)::int AS count, AVG(rating)::float AS avg
          FROM "Feedback" WHERE "createdAt" >= ${r.from} AND "createdAt" <= ${r.to} GROUP BY 1`, [])
      ]);
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let total = 0, weighted = 0;
      dist.forEach((d) => {
        const n = d._count._all;
        distribution[d.rating] = (distribution[d.rating] || 0) + n;
        total += n; weighted += d.rating * n;
      });
      const avg = total ? Math.round((weighted / total) * 100) / 100 : null;
      const tmap = new Map(trend.map((t) => [t.bucket, t]));
      return {
        success: true,
        range: rangeMeta(r),
        warnings,
        interval,
        total,
        averageRating: avg,
        previous: { total: prevAgg._count?._all || 0, averageRating: prevAgg._avg?.rating != null ? Math.round(prevAgg._avg.rating * 100) / 100 : null },
        distribution: [5, 4, 3, 2, 1].map((s) => ({ rating: s, count: distribution[s] || 0, pct: total ? Math.round(((distribution[s] || 0) / total) * 1000) / 10 : 0 })),
        trend: bucketKeys(r.from, r.to, interval).map((k) => {
          const t = tmap.get(k);
          return { date: k, count: t ? num(t.count) : 0, averageRating: t ? Math.round(num(t.avg) * 100) / 100 : null };
        })
      };
    });
  }));

  // ================= EXPORT (CSV stream) =================
  app.get('/analytics/export', handle(app, async (request, reply) => {
    const r = resolveRange(request.query);
    const type = pickEnum(request.query.type, Object.keys(EXPORTS), undefined);
    if (!type) throw new BadRequest('`type` is required: orders|users|downloads');
    const maxRows = pickInt(request.query.limit, EXPORT_MAX_ROWS, 1, EXPORT_MAX_ROWS);
    const cfg = EXPORTS[type];
    const select = Object.fromEntries(cfg.cols.map((c) => [c, true]));
    const where = { createdAt: { gte: r.from, lte: r.to } };
    const BATCH = 2000;

    async function* gen() {
      yield '﻿' + cfg.cols.join(',') + '\n';
      let cursor = null, sent = 0;
      while (sent < maxRows) {
        const rows = await prisma[cfg.model].findMany({
          where, select,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: Math.min(BATCH, maxRows - sent),
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        if (!rows.length) break;
        yield rows.map((row) => cfg.cols.map((c) => csvCell(row[c])).join(',')).join('\n') + '\n';
        sent += rows.length;
        cursor = rows[rows.length - 1].id;
        if (rows.length < BATCH) break;
      }
    }

    const stamp = `${r.from.toISOString().slice(0, 10)}_${r.to.toISOString().slice(0, 10)}`;
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${type}_${stamp}.csv"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(Readable.from(gen()));
  }));
}

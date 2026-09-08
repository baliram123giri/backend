import { renderHtmlToVectorPdf, renderHtmlToImage, renderHtmlToComboZip } from '../../services/pdfGenerator.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getContentDisposition } from '../../lib/headerUtils.js';
import * as Sentry from '@sentry/node';

const renderRateLimitConfig = {
  config: {
    rateLimit: {
      max: 15,
      timeWindow: '1 minute',
    },
  },
};

export default async function pdfRoutes(app, options) {
  app.post('/api/generate-pdf', renderRateLimitConfig, async (request, reply) => {
    const startTime = Date.now();
    try {
      const {
        html,
        totalPages = 1,
        fileName = 'biodata.pdf',
        snapshotData = null,
        orderId = null,
        templateId = null,
        name = 'Biodata',
      } = request.body || {};

      if (!html || typeof html !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "html" field in request body.',
        });
      }

      // ── 1. Save 24-Hour Snapshot (PostgreSQL + Redis) ──────────────────────
      let snapshotId = null;
      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        const snapshot = await prisma.downloadSnapshot.create({
          data: {
            name: typeof name === 'string' ? name.trim() : 'Biodata',
            format: 'PDF',
            templateId: templateId || null,
            orderId: orderId || null,
            snapshotData: snapshotData || {},
            renderedHtml: html,
            expiresAt,
          },
        });
        snapshotId = snapshot.id;

        // Fast Redis cache with 24-hour TTL (86,400 seconds)
        if (redis && redis.status === 'ready') {
          await redis.set(
            `snapshot:${snapshot.id}`,
            JSON.stringify({
              id: snapshot.id,
              name: snapshot.name,
              format: 'PDF',
              templateId,
              orderId,
              snapshotData,
              renderedHtml: html,
              expiresAt: expiresAt.toISOString(),
            }),
            'EX',
            86400
          ).catch((e) => console.warn('Redis snapshot cache error:', e.message));
        }
      } catch (dbErr) {
        // Non-blocking: even if snapshot save fails, continue generating PDF for user
        console.warn('[PDF Route] Snapshot save warning:', dbErr.message);
      }

      // ── 2. Render True Vector PDF via Pre-Warmed Chromium ──────────────────
      const pdfBuffer = await renderHtmlToVectorPdf(html, {
        totalPages: Number(totalPages) || 1,
        fileName,
      });

      const totalDuration = Date.now() - startTime;
      console.log(`[PDF Route] Completed in ${totalDuration}ms for "${fileName}"`);

      // ── 3. Stream Binary PDF Directly to User (No Print Dialog) ───────────
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', getContentDisposition(fileName, 'biodata', '.pdf'))
        .header('Content-Length', pdfBuffer.length)
        .header('X-Snapshot-Id', snapshotId || '')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(pdfBuffer);

    } catch (error) {
      const errorDuration = Date.now() - startTime;
      console.error(`[PDF Route] Error after ${errorDuration}ms:`, error);
      Sentry.captureException(error);

      reply.status(500).send({
        error: error?.message || 'Failed to generate vector PDF. Please try again.',
        durationMs: errorDuration,
      });
    }
  });

  // ── High-Speed Skia Image Generator (PNG & JPEG) ─────────────────────────────
  app.post('/api/generate-image', renderRateLimitConfig, async (request, reply) => {
    const startTime = Date.now();
    try {
      const {
        html,
        totalPages = 1,
        pageIndex = 0,
        fileName = 'biodata.png',
        format = 'png',
        bundleZip = false,
        snapshotData = null,
        orderId = null,
        templateId = null,
        name = 'Biodata',
      } = request.body || {};

      if (!html || typeof html !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "html" field in request body.',
        });
      }

      const cleanFormat = format.toLowerCase() === 'jpg' || format.toLowerCase() === 'jpeg' ? 'JPG' : 'PNG';
      const cleanName = (name || 'Biodata').replace(/[^a-zA-Z0-9_\u0900-\u0D7F]/g, '_');

      // 1. Save 24-Hour Snapshot (PostgreSQL + Redis)
      let snapshotId = null;
      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const snapshot = await prisma.downloadSnapshot.create({
          data: {
            name: typeof name === 'string' ? name.trim() : 'Biodata',
            format: cleanFormat,
            templateId: templateId || null,
            orderId: orderId || null,
            snapshotData: snapshotData || {},
            renderedHtml: html,
            expiresAt,
          },
        });
        snapshotId = snapshot.id;

        if (redis && redis.status === 'ready') {
          await redis.set(
            `snapshot:${snapshot.id}`,
            JSON.stringify({
              id: snapshot.id,
              name: snapshot.name,
              format: cleanFormat,
              templateId,
              orderId,
              snapshotData,
              renderedHtml: html,
              expiresAt: expiresAt.toISOString(),
            }),
            'EX',
            86400
          ).catch((e) => console.warn('Redis snapshot cache error:', e.message));
        }
      } catch (dbErr) {
        console.warn('[Image Route] Snapshot save warning:', dbErr.message);
      }

      // 2. Render Image via Pre-Warmed Chromium
      const result = await renderHtmlToImage(html, cleanFormat.toLowerCase(), {
        cleanName,
        pageIndex: Number(pageIndex) || 0,
        totalPages: Number(totalPages) || 1,
        bundleZip: Boolean(bundleZip),
      });

      const totalDuration = Date.now() - startTime;
      console.log(`[Image Route] Completed in ${totalDuration}ms for "${fileName}"`);

      // 3. Stream Binary File
      const isZip = result.isZip;
      const mimeType = isZip
        ? 'application/zip'
        : cleanFormat === 'PNG'
        ? 'image/png'
        : 'image/jpeg';
      const outFileName = isZip ? `${cleanName}_Images.zip` : fileName;
      const defaultExt = isZip ? '.zip' : (cleanFormat === 'PNG' ? '.png' : '.jpg');

      reply
        .header('Content-Type', mimeType)
        .header('Content-Disposition', getContentDisposition(outFileName, 'biodata', defaultExt))
        .header('Content-Length', result.buffer.length)
        .header('X-Snapshot-Id', snapshotId || '')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(result.buffer);

    } catch (error) {
      const errorDuration = Date.now() - startTime;
      console.error(`[Image Route] Error after ${errorDuration}ms:`, error);
      Sentry.captureException(error);

      reply.status(500).send({
        error: error?.message || 'Failed to generate image. Please try again.',
        durationMs: errorDuration,
      });
    }
  });

  // ── Combo Pack Generator (Vector PDF + PNG + JPEG in ZIP) ────────────────────
  app.post('/api/generate-combo', renderRateLimitConfig, async (request, reply) => {
    const startTime = Date.now();
    try {
      const {
        html,
        snapshotData = null,
        orderId = null,
        templateId = null,
        name = 'Biodata',
      } = request.body || {};

      if (!html || typeof html !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "html" field in request body.',
        });
      }

      const cleanName = (name || 'Biodata').replace(/[^a-zA-Z0-9_\u0900-\u0D7F]/g, '_');

      // 1. Save 24-Hour Snapshot
      let snapshotId = null;
      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const snapshot = await prisma.downloadSnapshot.create({
          data: {
            name: typeof name === 'string' ? name.trim() : 'Biodata',
            format: 'COMBO',
            templateId: templateId || null,
            orderId: orderId || null,
            snapshotData: snapshotData || {},
            renderedHtml: html,
            expiresAt,
          },
        });
        snapshotId = snapshot.id;

        if (redis && redis.status === 'ready') {
          await redis.set(
            `snapshot:${snapshot.id}`,
            JSON.stringify({
              id: snapshot.id,
              name: snapshot.name,
              format: 'COMBO',
              templateId,
              orderId,
              snapshotData,
              renderedHtml: html,
              expiresAt: expiresAt.toISOString(),
            }),
            'EX',
            86400
          ).catch((e) => console.warn('Redis snapshot cache error:', e.message));
        }
      } catch (dbErr) {
        console.warn('[Combo Route] Snapshot save warning:', dbErr.message);
      }

      // 2. Render Combo ZIP
      const zipBuffer = await renderHtmlToComboZip(html, { cleanName });

      const totalDuration = Date.now() - startTime;
      console.log(`[Combo Route] Completed in ${totalDuration}ms for "${cleanName}"`);

      // 3. Stream Binary ZIP
      const outFileName = `${cleanName}_Combo.zip`;

      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', getContentDisposition(outFileName, 'biodata_combo', '.zip'))
        .header('Content-Length', zipBuffer.length)
        .header('X-Snapshot-Id', snapshotId || '')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(zipBuffer);

    } catch (error) {
      const errorDuration = Date.now() - startTime;
      console.error(`[Combo Route] Error after ${errorDuration}ms:`, error);
      Sentry.captureException(error);

      reply.status(500).send({
        error: error?.message || 'Failed to generate combo pack. Please try again.',
        durationMs: errorDuration,
      });
    }
  });
}

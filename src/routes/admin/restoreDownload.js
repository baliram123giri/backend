import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import {
  renderHtmlToVectorPdf,
  renderHtmlToComboZip,
  renderHtmlToImage,
} from '../../services/pdfGenerator.js';
import * as Sentry from '@sentry/node';

export default async function restoreDownloadRoutes(app, options) {
  // GET /api/admin/restore-download/:id
  // 1-Click download of user's generated file from the 24-hour backup
  app.get('/restore-download/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      let snapshot = null;

      // 1. Try Redis first (fastest)
      if (redis && redis.status === 'ready') {
        const cached = await redis.get(`snapshot:${id}`).catch(() => null);
        if (cached) {
          try {
            snapshot = JSON.parse(cached);
          } catch {}
        }
      }

      // 2. Direct lookup in PostgreSQL
      if (!snapshot) {
        snapshot = await prisma.downloadSnapshot.findFirst({
          where: {
            OR: [
              { id },
              { downloadLogId: id },
              { orderId: id },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      // 3. If id is an Order primary key (UUID), resolve its razorpayOrderId
      if (!snapshot) {
        const order = await prisma.order.findUnique({
          where: { id },
          select: { id: true, razorpayOrderId: true },
        });

        if (order) {
          snapshot = await prisma.downloadSnapshot.findFirst({
            where: {
              OR: [
                { orderId: order.razorpayOrderId },
                { orderId: order.id },
              ],
            },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      // 4. If id is a DownloadLog primary key, resolve its orderId
      if (!snapshot) {
        const dLog = await prisma.downloadLog.findUnique({
          where: { id },
          select: { id: true, orderId: true },
        });

        if (dLog && dLog.orderId) {
          snapshot = await prisma.downloadSnapshot.findFirst({
            where: {
              OR: [
                { downloadLogId: dLog.id },
                { orderId: dLog.orderId },
              ],
            },
            orderBy: { createdAt: 'desc' },
          });
        }
      }

      if (!snapshot) {
        return reply.status(404).send({
          error: 'Generation snapshot not found or expired (retained for 24 hours).',
        });
      }

      const cleanName = (snapshot.name || 'Biodata').replace(/[^a-zA-Z0-9_\u0900-\u0D7F]/g, '_');
      const format = (snapshot.format || 'PDF').toUpperCase();

      // ── 1. If COMBO: stream real uncorrupted ZIP (Vector PDF + PNG + JPEG) ─
      if (format === 'COMBO' && snapshot.renderedHtml) {
        const fileName = `${cleanName}_restored.zip`;
        const zipBuffer = await renderHtmlToComboZip(snapshot.renderedHtml, {
          cleanName,
        });

        const safeFileName = encodeURIComponent(fileName).replace(/['()]/g, escape);
        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${safeFileName}`)
          .header('Content-Length', zipBuffer.length)
          .send(zipBuffer);
      }

      // ── 2. If PDF: generate vector PDF from the preserved rendered HTML ─────
      if (format === 'PDF' && snapshot.renderedHtml) {
        const fileName = `${cleanName}_restored.pdf`;
        const pdfBuffer = await renderHtmlToVectorPdf(snapshot.renderedHtml, {
          fileName,
        });

        const safeFileName = encodeURIComponent(fileName).replace(/['()]/g, escape);
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${safeFileName}`)
          .header('Content-Length', pdfBuffer.length)
          .send(pdfBuffer);
      }

      // ── 3. If PNG or JPG: generate crisp image directly ───────────────────
      if ((format === 'PNG' || format === 'JPG' || format === 'JPEG') && snapshot.renderedHtml) {
        const ext = format === 'PNG' ? 'png' : 'jpg';
        const fileName = `${cleanName}_restored.${ext}`;
        const result = await renderHtmlToImage(snapshot.renderedHtml, ext, {
          cleanName,
          totalPages: 1,
        });

        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const safeFileName = encodeURIComponent(fileName).replace(/['()]/g, escape);
        return reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${safeFileName}`)
          .header('Content-Length', result.buffer.length)
          .send(result.buffer);
      }

      // ── 4. Fallback if rendered HTML is missing ───────────────────────────
      return reply.send({
        success: true,
        id: snapshot.id,
        name: snapshot.name,
        format: snapshot.format,
        snapshotData: snapshot.snapshotData,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt,
      });

    } catch (error) {
      console.error('[Restore Download Route] Error:', error);
      Sentry.captureException(error);
      return reply.status(500).send({
        error: error?.message || 'Failed to restore download.',
      });
    }
  });

  // GET /api/admin/snapshot/:id
  // Returns raw snapshot JSON (for editor / inspection)
  app.get('/snapshot/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const snapshot = await prisma.downloadSnapshot.findUnique({
        where: { id },
      });
      if (!snapshot) {
        return reply.status(404).send({ error: 'Snapshot not found' });
      }
      return reply.send({ snapshot });
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });
}

import { prisma, withRetry } from '../../lib/prisma.js';
import { getCachedOrFetch, redis } from '../../lib/redis.js';
import { getContentDisposition } from '../../lib/headerUtils.js';
import {
  renderHtmlToVectorPdf,
  renderHtmlToImage,
  renderHtmlToComboZip,
} from '../../services/pdfGenerator.js';
import crypto from 'crypto';
// Razorpay SDK removed — app now uses Cashfree exclusively.
import { getCashfreeOrderStatus, getCashfreeConfig } from '../../services/cashfree.js';

export default async function routes(app, options) {
  // 1. GET /api/cashfree/active-coupons (also aliased from /api/razorpay/ for legacy)
  app.get('/api/razorpay/active-coupons', async (request, reply) => {
    try {
      const cacheKey = 'active-coupons';
      const data = await getCachedOrFetch(cacheKey, 300, async () => {
        const coupons = await prisma.coupon.findMany({
          where: {
            active: true,
            isPublic: true,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });
        const validCoupons = coupons.filter(
          (c) => c.maxUses === null || c.usedCount < c.maxUses
        );
        return validCoupons;
      });
      return reply.send({ success: true, coupons: data });
    } catch (error) {
      app.log.error('GET active coupons error:', error);
      return reply.status(500).send({ error: 'Failed to fetch active coupons' });
    }
  });

  // 2. POST /api/cashfree/validate-coupon (also aliased from /api/razorpay/ for legacy)
  app.post('/api/razorpay/validate-coupon', async (request, reply) => {
    try {
      const { code } = request.body || {};

      if (!code) {
        return reply.status(400).send({ error: 'Coupon code is required' });
      }

      const cleanCode = code.trim().toUpperCase();

      // Seed default coupons if DB has 0 coupons
      const count = await prisma.coupon.count();
      if (count === 0) {
        try {
          await prisma.coupon.createMany({
            data: [
              { code: 'WELCOME50', discountType: 'percentage', discountValue: 50, active: true },
              { code: 'LOVE20', discountType: 'percentage', discountValue: 20, active: true },
              { code: 'FREE100', discountType: 'percentage', discountValue: 100, active: true },
              { code: 'BIODATA10', discountType: 'fixed', discountValue: 10, active: true },
            ],
          });
        } catch (seedErr) {
          console.error('Failed to seed default coupons:', seedErr);
        }
      }

      const coupon = await prisma.coupon.findUnique({
        where: { code: cleanCode },
      });

      if (!coupon) {
        return reply.status(404).send({ error: 'Invalid coupon code' });
      }

      if (!coupon.active) {
        return reply.status(400).send({ error: 'This coupon is no longer active' });
      }

      if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
        return reply.status(400).send({ error: 'This coupon has expired' });
      }

      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
        return reply.status(400).send({ error: 'This coupon usage limit has been reached' });
      }

      return reply.send({
        success: true,
        message: 'Coupon applied successfully',
        coupon: {
          code: coupon.code,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
        },
      });
    } catch (error) {
      app.log.error('Coupon Validation Error:', error);
      return reply.status(500).send({ error: 'Failed to validate coupon', details: error.message });
    }
  });

  // NOTE: /api/razorpay/create-order is deprecated — Cashfree handles this via /api/cashfree/create-order
  // This endpoint is kept as a stub returning 410 Gone to gracefully handle any lingering old requests.
  app.post('/api/razorpay/create-order', async (_request, reply) => {
    return reply.status(410).send({ error: 'Razorpay has been removed. Please use Cashfree checkout.' });
  });

  // NOTE: /api/razorpay/verify-payment deprecated stub
  app.post('/api/razorpay/verify-payment', async (_request, reply) => {
    return reply.status(410).send({ error: 'Razorpay has been removed. Please use Cashfree checkout.' });
  });

  // NOTE: /api/razorpay/callback deprecated stub
  app.route({
    method: ['GET', 'POST'],
    url: '/api/razorpay/callback',
    handler: async (_request, reply) => {
      const clientUrl = process.env.CLIENT_URL || 'https://biodata99.com';
      return reply.redirect(`${clientUrl}/payment-processing?status=failed&error=${encodeURIComponent('Razorpay has been removed. Please retry with Cashfree.')}`, 303);
    }
  });

  // 5. POST /api/razorpay/update-download-status
  app.post('/api/razorpay/update-download-status', async (request, reply) => {
    try {
      const { orderId, downloadStatus, errorMsg } = request.body || {};

      if (!orderId || !downloadStatus) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      // Allowlist guard — only accept known status values
      const VALID_STATUSES = ['success', 'failed', 'pending'];
      if (!VALID_STATUSES.includes(downloadStatus)) {
        return reply.status(400).send({ error: `Invalid downloadStatus value: ${downloadStatus}` });
      }

      if (orderId === 'sandbox') {
        return reply.send({ success: true, message: 'Sandbox skipped' });
      }

      try {
        const updateData = { downloadStatus };
        // Persist errorMsg so admin dashboard can diagnose failed downloads
        if (errorMsg && downloadStatus === 'failed') {
          updateData.downloadErrorMsg = String(errorMsg).slice(0, 500); // cap length
        }
        await prisma.order.update({
          where: { razorpayOrderId: orderId },
          data: updateData,
        });
      } catch (dbErr) {
        // Graceful degradation — the schema field might not exist yet
        app.log.warn('[update-download-status] DB update failed:', dbErr.message);
      }

      return reply.send({ success: true });
    } catch (err) {
      app.log.error('Failed to update download status API:', err);
      return reply.status(200).send({ success: false, error: 'Internal Server Error' });
    }
  });

  // 5.5 GET /api/razorpay/order-status/:orderId
  // Fast status check + direct Razorpay auto-verification for mobile app-switch & polling
  app.get('/api/razorpay/order-status/:orderId', async (request, reply) => {
    try {
      const { orderId } = request.params;
      if (!orderId) {
        return reply.status(400).send({ error: 'Order ID is required' });
      }

      let order = await prisma.order.findFirst({
        where: {
          OR: [
            { razorpayOrderId: orderId },
            { id: orderId },
          ],
        },
      });

      if (!order) {
        return reply.status(404).send({ error: 'Order not found' });
      }

      // If already marked paid, return immediately
      if (order.status === 'paid') {
        return reply.send({
          success: true,
          status: 'paid',
          order: {
            id: order.id,
            razorpayOrderId: order.razorpayOrderId,
            razorpayPaymentId: order.razorpayPaymentId,
            status: order.status,
            format: order.format,
            customerName: order.customerName,
          },
        });
      }

      // Zero-Failure Safety Net: If order is not marked paid yet, check gateway directly
      if (order.status !== 'paid' && order.razorpayOrderId && order.razorpayOrderId.startsWith('cf_')) {
        try {
          const cfConfig = getCashfreeConfig();
          if (cfConfig.isConfigured) {
            const cfOrder = await getCashfreeOrderStatus(order.razorpayOrderId);
            if (cfOrder && cfOrder.order_status === 'PAID') {
              order = await withRetry(() =>
                prisma.order.update({
                  where: { id: order.id },
                  data: {
                    status: 'paid',
                    razorpayPaymentId: `cf_verified_${Date.now()}`,
                  },
                })
              );
              return reply.send({
                success: true,
                status: 'paid',
                order: {
                  id: order.id,
                  razorpayOrderId: order.razorpayOrderId,
                  status: 'paid',
                  format: order.format,
                  customerName: order.customerName,
                },
              });
            }
          }
        } catch (cfErr) {
          app.log.warn('[order-status] Cashfree auto-verify warn:', cfErr.message);
        }
      }


      return reply.send({
        success: true,
        status: order.status || 'pending',
        order: {
          id: order.id,
          razorpayOrderId: order.razorpayOrderId,
          status: order.status,
          format: order.format,
        },
      });
    } catch (error) {
      app.log.error('GET order status error:', error);
      return reply.status(500).send({ error: 'Failed to fetch order status' });
    }
  });

  // 6. Razorpay callback — now a 410 stub (duplicate of stubs above, kept for belt-and-suspenders)


  // 7. GET /api/payment/download-paid-order/:orderId
  // Zero-click auto-download endpoint for verified paid orders
  app.get('/api/payment/download-paid-order/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    try {
      if (!orderId) {
        return reply.status(400).send({ error: 'Order ID is required' });
      }

      let order = await prisma.order.findFirst({
        where: {
          OR: [
            { razorpayOrderId: orderId },
            { id: orderId },
          ],
        },
      });

      if (!order) {
        return reply.status(404).send({ error: 'Order not found' });
      }

      // Cashfree Safety Net: If order is not marked paid yet, check Cashfree directly
      if (order.status !== 'paid' && order.razorpayOrderId) {
        try {
          const cfConfig = getCashfreeConfig();
          if (cfConfig.isConfigured) {
            const cfOrder = await getCashfreeOrderStatus(order.razorpayOrderId);
            if (cfOrder && cfOrder.order_status === 'PAID') {
              order = await prisma.order.update({
                where: { id: order.id },
                data: {
                  status: 'paid',
                  razorpayPaymentId: `cf_verified_${Date.now()}`,
                },
              });
            }
          }
        } catch (cfErr) {
          app.log.warn('[download-paid-order] Cashfree auto-verify warn:', cfErr.message);
        }
      }

      if (order.status !== 'paid') {
        return reply.status(402).send({ error: 'Order payment has not been completed' });
      }

      let snapshot = null;

      // 1. Try Redis cache first
      if (redis && redis.status === 'ready') {
        const cached = await redis.get(`snapshot:${order.razorpayOrderId}`).catch(() => null);
        if (cached) {
          try {
            snapshot = JSON.parse(cached);
          } catch {}
        }
      }

      // 2. Query PostgreSQL
      if (!snapshot) {
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

      // 3. Fallback: match by customerName (only look FORWARD from order creation,
      //    within a 2-hour window to avoid cross-customer false matches)
      if (!snapshot && order.customerName) {
        snapshot = await prisma.downloadSnapshot.findFirst({
          where: {
            name: order.customerName,
            createdAt: {
              gte: order.createdAt, // snapshots are saved DURING/AFTER checkout, not before
              lte: new Date(order.createdAt.getTime() + 2 * 60 * 60 * 1000), // 2-hour window
            },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      // CRITICAL: null-check snapshot BEFORE accessing any property on it.
      // snapshot.renderedHtml?.match() would throw TypeError if snapshot itself is null.
      if (!snapshot || !snapshot.renderedHtml) {
        app.log.warn(`[Download Paid Order] Snapshot not found or empty for order: ${order.razorpayOrderId || order.id}`);
        return reply.status(404).send({
          error: 'Document snapshot data is incomplete. Please contact support.',
        });
      }

      // Extract body content for validation; fall back to full HTML if no <body> tag present
      const bodyMatch = snapshot.renderedHtml.match(/<body[^>]*>([\/\s\S]*?)<\/body>/i);
      const bodyContent = bodyMatch ? bodyMatch[1].trim() : snapshot.renderedHtml.trim();
      if (!bodyContent) {
        app.log.warn(`[Download Paid Order] Snapshot body is empty for order: ${order.razorpayOrderId || order.id}`);
        return reply.status(404).send({
          error: 'Document snapshot data is incomplete. Please contact support.',
        });
      }

      const format = (order.format || snapshot.format || 'PDF').toUpperCase();
      const cleanName = (snapshot.name || order.customerName || 'Biodata').replace(/[^a-zA-Z0-9_\u0900-\u0D7F]/g, '_');

      // Mark order as successfully downloaded ONLY when the network stream completes cleanly
      const markSuccessOnFinish = () => {
        if (reply.raw) {
          reply.raw.on('finish', () => {
            prisma.order.update({
              where: { id: order.id },
              data: { downloadStatus: 'success' },
            }).catch((err) => app.log.warn('Failed to update downloadStatus on finish:', err.message));
          });
        }
      };

      // 1. PDF format
      if (format === 'PDF') {
        const fileName = `${cleanName}.pdf`;
        const pdfBuffer = await renderHtmlToVectorPdf(snapshot.renderedHtml, { fileName });
        const contentDisposition = getContentDisposition(fileName, 'biodata', '.pdf');
        markSuccessOnFinish();

        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', contentDisposition)
          .header('Content-Length', pdfBuffer.length)
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .send(pdfBuffer);
      }

      // 2. Image format (PNG or JPG)
      if (format === 'PNG' || format === 'JPG' || format === 'JPEG') {
        const ext = format === 'PNG' ? 'png' : 'jpg';
        const fileName = `${cleanName}.${ext}`;
        const result = await renderHtmlToImage(snapshot.renderedHtml, ext, {
          cleanName,
          totalPages: 1,
        });
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const contentDisposition = getContentDisposition(fileName, 'biodata', `.${ext}`);
        markSuccessOnFinish();

        return reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', contentDisposition)
          .header('Content-Length', result.buffer.length)
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .send(result.buffer);
      }

      // 3. COMBO format
      if (format === 'COMBO') {
        const fileName = `${cleanName}_Combo.zip`;
        const zipBuffer = await renderHtmlToComboZip(snapshot.renderedHtml, { cleanName });
        const contentDisposition = getContentDisposition(fileName, 'biodata_combo', '.zip');
        markSuccessOnFinish();

        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', contentDisposition)
          .header('Content-Length', zipBuffer.length)
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .send(zipBuffer);
      }

      return reply.status(400).send({ error: `Unsupported format: ${format}` });
    } catch (err) {
      app.log.error('Download paid order error:', err);
      return reply.status(500).send({ error: 'Failed to generate document for paid order' });
    }
  });
}

// Helper to create commission for paid order
async function createCommissionForOrder(order, app) {
  try {
    if (!order.referralCode) return;
    
    // Find approved affiliate with this referral code
    const affiliate = await prisma.affiliate.findFirst({
      where: {
        code: order.referralCode.trim().toUpperCase(),
        status: 'approved'
      }
    });

    if (!affiliate) {
      app?.log?.warn(`[Commission] No approved affiliate found with code: ${order.referralCode}`);
      return;
    }

    // Check if commission already exists for this order to prevent duplicates
    const existing = await prisma.commission.findUnique({
      where: { orderId: order.razorpayOrderId }
    });

    if (existing) {
      app?.log?.info(`[Commission] Commission already exists for order: ${order.razorpayOrderId}`);
      return;
    }

    // Calculate commission dynamically based on format and affiliate's rates.
    // NOTE: order.format is stored uppercase ('PDF', 'COMBO', 'PNG' etc.)
    // — must normalize before comparing to avoid always falling through to normal rate.
    let rate = 30; // default normal rate
    if ((order.format || '').toUpperCase() === 'COMBO') {
      rate = affiliate.comboCommissionRate != null ? affiliate.comboCommissionRate : 35;
    } else {
      rate = affiliate.commissionRate != null ? affiliate.commissionRate : 30;
    }
    const commissionPercent = rate / 100;
    const commissionAmount = parseFloat((order.amount * commissionPercent).toFixed(2));

    if (commissionAmount <= 0) {
      app?.log?.info(`[Commission] Commission amount is 0 or less for order: ${order.razorpayOrderId}`);
      return;
    }

    // Create the Commission record
    const commission = await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        orderId: order.razorpayOrderId,
        orderAmount: order.amount,
        commissionAmount,
        status: 'pending', // Starts as pending review
      }
    });

    app?.log?.info(`[Commission] Successfully created commission of ₹${commissionAmount} for affiliate ${affiliate.name} (Code: ${affiliate.code}) on order ${order.razorpayOrderId}`);
  } catch (err) {
    app?.log?.error('[Commission] Error creating commission for order:', err);
  }
}

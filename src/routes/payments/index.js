import { prisma, withRetry } from '../../lib/prisma.js';
import { getCachedOrFetch, redis } from '../../lib/redis.js';
import { getContentDisposition } from '../../lib/headerUtils.js';
import {
  renderHtmlToVectorPdf,
  renderHtmlToImage,
  renderHtmlToComboZip,
} from '../../services/pdfGenerator.js';
import crypto from 'crypto';
import Razorpay from 'razorpay';

export default async function routes(app, options) {
  // 1. GET /api/razorpay/active-coupons
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

  // 2. POST /api/razorpay/validate-coupon
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

  // 3. POST /api/razorpay/create-order
  app.post('/api/razorpay/create-order', async (request, reply) => {
    try {
      const {
        amount,
        currency,
        templateId,
        format,
        customerName,
        customerEmail,
        customerPhone,
        couponCode,
        ref,
        html,
        renderedHtml,
        snapshotData,
      } = request.body || {};

      if (amount === undefined || amount === null || !templateId || !format) {
        return reply.status(400).send({ error: 'Amount, templateId, and format are required fields' });
      }

      let discountApplied = 0;
      let finalAmount = parseFloat(amount);

      if (couponCode) {
        const cleanCoupon = couponCode.trim().toUpperCase();
        const couponRecord = await withRetry(() =>
          prisma.coupon.findUnique({ where: { code: cleanCoupon } })
        );

        if (couponRecord && couponRecord.active) {
          const isNotExpired = !couponRecord.expiresAt || new Date(couponRecord.expiresAt) > new Date();
          const hasRemainingUses = !couponRecord.maxUses || couponRecord.usedCount < couponRecord.maxUses;

          if (isNotExpired && hasRemainingUses) {
            if (couponRecord.discountType === 'percentage') {
              discountApplied = (finalAmount * couponRecord.discountValue) / 100;
            } else {
              discountApplied = Math.min(couponRecord.discountValue, finalAmount);
            }
            finalAmount = Math.max(0, finalAmount - discountApplied);

            // Update coupon usage count
            withRetry(() =>
              prisma.coupon.update({
                where: { id: couponRecord.id },
                data: { usedCount: { increment: 1 } },
              })
            ).catch((e) => console.error('Failed to increment coupon usedCount:', e));
          }
        }
      }

      const RAZORPAY_MIN_AMOUNT_INR = 1;
      if (finalAmount > 0 && finalAmount < RAZORPAY_MIN_AMOUNT_INR) {
        finalAmount = RAZORPAY_MIN_AMOUNT_INR;
      }

      if (finalAmount <= 0) {
        const freeOrderId = `free_promo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        await withRetry(() =>
          prisma.order.create({
            data: {
              razorpayOrderId: freeOrderId,
              razorpayPaymentId: `free_coupon_applied_${Date.now()}`,
              razorpaySignature: 'free_checkout_signature',
              amount: 0,
              currency: currency || 'INR',
              status: 'paid',
              format,
              templateId,
              customerName: customerName || null,
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              couponCode: couponCode || null,
              discountApplied: parseFloat(amount),
              referralCode: ref || null,
            },
          })
        );

        const snapshotHtml = html || renderedHtml;
        if (snapshotHtml) {
          try {
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await prisma.downloadSnapshot.create({
              data: {
                name: customerName || 'Biodata',
                format: (format || 'PDF').toUpperCase(),
                templateId: templateId || null,
                orderId: freeOrderId,
                snapshotData: snapshotData || {},
                renderedHtml: snapshotHtml,
                expiresAt,
              },
            });
          } catch (snapErr) {
            app.log.warn('[Create Order] Free promo snapshot save warning:', snapErr.message);
          }
        }

        return reply.send({
          success: true,
          isFreeOrder: true,
          order: {
            id: freeOrderId,
            amount: 0,
            currency: currency || 'INR',
          },
        });
      }

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
      const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
      const isSandbox = !keyId || !keySecret || keyId === 'rzp_test_placeholder' || keySecret === 'placeholder_secret_key';

      if (isSandbox) {
        const mockOrderId = `mock_order_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        await withRetry(() =>
          prisma.order.create({
            data: {
              razorpayOrderId: mockOrderId,
              amount: finalAmount,
              currency: currency || 'INR',
              status: 'pending',
              format,
              templateId,
              customerName: customerName || null,
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              couponCode: couponCode || null,
              discountApplied: discountApplied,
              referralCode: ref || null,
            },
          })
        );

        const snapshotHtml = html || renderedHtml;
        if (snapshotHtml) {
          try {
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await prisma.downloadSnapshot.create({
              data: {
                name: customerName || 'Biodata',
                format: (format || 'PDF').toUpperCase(),
                templateId: templateId || null,
                orderId: mockOrderId,
                snapshotData: snapshotData || {},
                renderedHtml: snapshotHtml,
                expiresAt,
              },
            });
          } catch (snapErr) {
            app.log.warn('[Create Order] Mock snapshot save warning:', snapErr.message);
          }
        }

        return reply.send({
          success: true,
          isSandbox: true,
          order: {
            id: mockOrderId,
            amount: Math.round(finalAmount * 100),
            currency: currency || 'INR',
          },
          keyId: 'sandbox_key',
        });
      }

      const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });

      const amountInPaise = Math.round(finalAmount * 100);
      const paymentOrder = await razorpay.orders.create({
        amount: amountInPaise,
        currency: currency || 'INR',
        receipt: `receipt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      });

      await withRetry(() =>
        prisma.order.create({
          data: {
            razorpayOrderId: paymentOrder.id,
            amount: finalAmount,
            currency: currency || 'INR',
            status: 'pending',
            format,
            templateId,
            customerName: customerName || null,
            customerEmail: customerEmail || null,
            customerPhone: customerPhone || null,
            couponCode: couponCode || null,
            discountApplied: discountApplied,
            referralCode: ref || null,
          },
        })
      );

      const snapshotHtml = html || renderedHtml;
      if (snapshotHtml) {
        try {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          const snap = await prisma.downloadSnapshot.create({
            data: {
              name: customerName || 'Biodata',
              format: (format || 'PDF').toUpperCase(),
              templateId: templateId || null,
              orderId: paymentOrder.id,
              snapshotData: snapshotData || {},
              renderedHtml: snapshotHtml,
              expiresAt,
            },
          });
          if (redis && redis.status === 'ready') {
            await redis.set(
              `snapshot:${paymentOrder.id}`,
              JSON.stringify({
                id: snap.id,
                name: snap.name,
                format: snap.format,
                templateId,
                orderId: paymentOrder.id,
                snapshotData,
                renderedHtml: snapshotHtml,
                expiresAt: expiresAt.toISOString(),
              }),
              'EX',
              86400
            ).catch(() => {});
          }
        } catch (snapErr) {
          app.log.warn('[Create Order] Live snapshot pre-save warning:', snapErr.message);
        }
      }

      return reply.send({
        success: true,
        isSandbox: false,
        order: paymentOrder,
        keyId: keyId,
      });
    } catch (error) {
      app.log.error('Create Razorpay Order Error:', error);
      return reply.status(500).send({ error: 'Failed to create order', details: error.message });
    }
  });

  // 4. POST /api/razorpay/verify-payment
  app.post('/api/razorpay/verify-payment', async (request, reply) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        razorpay_contact,
        razorpay_email,
        isSandbox,
      } = request.body || {};

      if (!razorpay_order_id) {
        return reply.status(400).send({ error: 'Order ID is required' });
      }

      const buildContactUpdate = (email, phone) => {
        const update = {};
        if (phone) update.customerPhone = String(phone).replace(/\D/g, '').slice(-10);
        if (email && email.includes('@')) update.customerEmail = String(email).trim();
        return update;
      };

      const isProduction = process.env.NODE_ENV === 'production';
      const allowMock = !isProduction && (isSandbox === true || razorpay_order_id.startsWith('mock_order_'));

      if (allowMock) {
        const contactUpdate = buildContactUpdate(razorpay_email, razorpay_contact);

        const updatedOrder = await withRetry(() =>
          prisma.order.update({
            where: { razorpayOrderId: razorpay_order_id },
            data: {
              status: 'paid',
              razorpayPaymentId: razorpay_payment_id || `mock_pay_${Date.now()}`,
              razorpaySignature: razorpay_signature || 'mock_signature',
              ...contactUpdate,
            },
          })
        );

        if (updatedOrder.referralCode) {
          await createCommissionForOrder(updatedOrder, app);
        }

        return reply.send({
          success: true,
          message: 'Sandbox payment verified successfully',
          order: updatedOrder,
        });
      }

      if (!razorpay_payment_id || !razorpay_signature) {
        return reply.status(400).send({ error: 'Payment ID and signature are required for live verification' });
      }

      const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
      if (!keySecret) {
        app.log.error('RAZORPAY_KEY_SECRET is not configured on server');
        return reply.status(500).send({ error: 'Payment gateway configuration error' });
      }

      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      const signatureBuffer = Buffer.from(razorpay_signature, 'utf8');
      const isSignatureValid =
        expectedBuffer.length === signatureBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, signatureBuffer);

      if (!isSignatureValid) {
        await withRetry(() =>
          prisma.order.update({
            where: { razorpayOrderId: razorpay_order_id },
            data: { status: 'failed' },
          })
        ).catch((e) => console.error('Failed to mark order as failed:', e));

        return reply.status(400).send({ error: 'Invalid payment signature' });
      }

      let confirmedEmail = razorpay_email || undefined;
      let confirmedPhone = razorpay_contact || undefined;

      try {
        const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
        if (keyId && keySecret) {
          const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
          const payment = await rzp.payments.fetch(razorpay_payment_id);
          if (payment?.email && payment.email.includes('@')) {
            confirmedEmail = payment.email;
          }
          if (payment?.contact) {
            confirmedPhone = String(payment.contact).replace(/\D/g, '').slice(-10);
          }
        }
      } catch (fetchErr) {
        console.warn('[verify-payment] Could not fetch payment details from Razorpay:', fetchErr.message);
      }

      const contactUpdate = buildContactUpdate(confirmedEmail, confirmedPhone);

      const updatedOrder = await withRetry(() =>
        prisma.order.update({
          where: { razorpayOrderId: razorpay_order_id },
          data: {
            status: 'paid',
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            ...contactUpdate,
          },
        })
      );

      if (updatedOrder.referralCode) {
        await createCommissionForOrder(updatedOrder, app);
      }

      return reply.send({
        success: true,
        message: 'Payment verified and completed successfully',
        order: updatedOrder,
      });
    } catch (error) {
      app.log.error('Verify Payment Error:', error);
      return reply.status(500).send({ error: 'Payment verification failed', details: error.message });
    }
  });

  // 5. POST /api/razorpay/update-download-status
  app.post('/api/razorpay/update-download-status', async (request, reply) => {
    try {
      const { orderId, downloadStatus } = request.body || {};

      if (!orderId || !downloadStatus) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      if (orderId === 'sandbox') {
        return reply.send({ success: true, message: 'Sandbox skipped' });
      }

      try {
        await prisma.order.update({
          where: { razorpayOrderId: orderId },
          data: { downloadStatus },
        });
      } catch (dbErr) {
        console.warn('DB update of download status failed (Prisma schema might be out of sync):', dbErr);
      }

      return reply.send({ success: true });
    } catch (err) {
      app.log.error('Failed to update download status API:', err);
      return reply.status(200).send({ success: false, error: 'Internal Server Error' });
    }
  });

  // 6. POST & GET /api/razorpay/callback (For mobile app-switch & redirect payments like PhonePe, GPay)
  app.route({
    method: ['GET', 'POST'],
    url: '/api/razorpay/callback',
    handler: async (request, reply) => {
      const clientUrl = process.env.CLIENT_URL || 'https://biodata99.com';
      try {
        const body = request.body || {};
        const query = request.query || {};

        const razorpay_order_id = body.razorpay_order_id || query.razorpay_order_id;
        const razorpay_payment_id = body.razorpay_payment_id || query.razorpay_payment_id;
        const razorpay_signature = body.razorpay_signature || query.razorpay_signature;
        const errorCode = body['error[code]'] || query['error[code]'];
        const errorDescription = body['error[description]'] || query['error[description]'];

        if (errorCode || !razorpay_payment_id || !razorpay_signature) {
          const errorMsg = errorDescription || 'Payment was cancelled or could not be completed';
          const failRedirect = `${clientUrl}/?payment_callback=1&order_id=${encodeURIComponent(razorpay_order_id || '')}&status=failed&error=${encodeURIComponent(errorMsg)}`;
          return reply.status(303).redirect(failRedirect);
        }

        const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
        let isVerified = false;

        if (keySecret) {
          const generatedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

          const genBuf = Buffer.from(generatedSignature, 'utf8');
          const signBuf = Buffer.from(razorpay_signature, 'utf8');
          isVerified = genBuf.length === signBuf.length && crypto.timingSafeEqual(genBuf, signBuf);
        } else {
          isVerified = process.env.NODE_ENV !== 'production';
        }

        if (!isVerified) {
          const failRedirect = `${clientUrl}/?payment_callback=1&order_id=${encodeURIComponent(razorpay_order_id)}&status=failed&error=${encodeURIComponent('Payment signature verification failed')}`;
          return reply.status(303).redirect(failRedirect);
        }

        const updatedOrder = await withRetry(() =>
          prisma.order.update({
            where: { razorpayOrderId: razorpay_order_id },
            data: {
              status: 'paid',
              razorpayPaymentId: razorpay_payment_id,
              razorpaySignature: razorpay_signature,
            },
          })
        );

        if (updatedOrder?.referralCode) {
          createCommissionForOrder(updatedOrder, app).catch((e) =>
            app.log.warn('Commission error in callback:', e.message)
          );
        }

        if (redis && redis.status === 'ready') {
          redis.del('admin:dashboard-stats').catch(() => {});
        }

        const successRedirect = `${clientUrl}/?payment_callback=1&order_id=${encodeURIComponent(razorpay_order_id)}&status=success`;
        return reply.status(303).redirect(successRedirect);
      } catch (error) {
        app.log.error('Razorpay callback error:', error);
        return reply.status(303).redirect(`${clientUrl}/?payment_callback=1&status=failed&error=${encodeURIComponent('Unexpected payment callback error')}`);
      }
    }
  });

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

      // Zero-Failure Safety Net: If order is not marked paid yet, check Razorpay directly
      if (order.status !== 'paid' && order.razorpayOrderId) {
        try {
          const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID;
          const keySecret = process.env.RAZORPAY_KEY_SECRET;
          if (keyId && keySecret) {
            const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
            const payments = await rzp.orders.fetchPayments(order.razorpayOrderId);
            const capturedPayment = payments?.items?.find((p) => p.status === 'captured');
            if (capturedPayment) {
              order = await prisma.order.update({
                where: { id: order.id },
                data: {
                  status: 'paid',
                  razorpayPaymentId: capturedPayment.id,
                },
              });
            }
          }
        } catch (fetchErr) {
          app.log.warn('Auto-verify check error:', fetchErr.message);
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

      // 3. Fallback: match by customerName
      if (!snapshot && order.customerName) {
        snapshot = await prisma.downloadSnapshot.findFirst({
          where: {
            name: order.customerName,
            createdAt: {
              gte: new Date(order.createdAt.getTime() - 24 * 60 * 60 * 1000),
            },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (!snapshot || !snapshot.renderedHtml) {
        return reply.status(404).send({
          error: 'Document snapshot not found or expired. Please contact support.',
        });
      }

      const format = (order.format || snapshot.format || 'PDF').toUpperCase();
      const cleanName = (snapshot.name || order.customerName || 'Biodata').replace(/[^a-zA-Z0-9_\u0900-\u0D7F]/g, '_');

      // 1. PDF format
      if (format === 'PDF') {
        const fileName = `${cleanName}.pdf`;
        const pdfBuffer = await renderHtmlToVectorPdf(snapshot.renderedHtml, { fileName });
        const contentDisposition = getContentDisposition(fileName, 'biodata', '.pdf');

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

    // Calculate commission dynamically based on format and affiliate's rates
    let rate = 30; // default normal rate
    if (order.format === 'combo') {
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

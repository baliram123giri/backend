import zlib from 'zlib';
import { prisma, withRetry } from '../../lib/prisma.js';
import { getCachedOrFetch, redis } from '../../lib/redis.js';
import {
  getCashfreeConfig,
  createCashfreeOrder,
  getCashfreeOrderStatus,
  getCashfreeOrderPayments,
  verifyCashfreeWebhookSignature,
} from '../../services/cashfree.js';

// Affiliate commission helper (same logic used in existing payments)
async function createCommissionForOrder(order, app) {
  try {
    if (!order.referralCode) return;
    const affiliate = await prisma.affiliateUser.findUnique({
      where: { referralCode: order.referralCode.trim().toUpperCase() },
    });
    if (!affiliate || affiliate.status !== 'active') return;

    const commissionRate = affiliate.commissionRate || 20; // 20% default
    const commissionAmount = parseFloat(((order.amount * commissionRate) / 100).toFixed(2));
    if (commissionAmount <= 0) return;

    await prisma.affiliateCommission.create({
      data: {
        affiliateId: affiliate.id,
        orderId: order.id,
        orderAmount: order.amount,
        commissionRate,
        commissionAmount,
        status: 'pending',
      },
    });

    await prisma.affiliateUser.update({
      where: { id: affiliate.id },
      data: {
        totalEarnings: { increment: commissionAmount },
        unpaidBalance: { increment: commissionAmount },
      },
    });
  } catch (err) {
    app.log.warn('[Cashfree Commission] Failed to record commission:', err.message);
  }
}

// Snapshot helper for instant post-payment generation
async function saveDownloadSnapshotHelper({
  orderId,
  customerName,
  format,
  templateId,
  snapshotData,
  snapshotHtml,
  isGzipped,
  app,
}) {
  if (!orderId || !snapshotHtml) return null;
  try {
    let finalHtml = snapshotHtml;
    if (isGzipped) {
      try {
        const buf = Buffer.from(snapshotHtml, 'base64');
        finalHtml = zlib.gunzipSync(buf).toString('utf-8');
      } catch (gzipErr) {
        app?.log?.warn?.('[Cashfree Snapshot Save] Gzip decompression failed, using raw:', gzipErr.message);
      }
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dbSaveOperation = async () => {
      const existing = await withRetry(() =>
        prisma.downloadSnapshot.findFirst({
          where: { orderId },
          select: { id: true },
        })
      );

      let snap;
      if (existing) {
        snap = await withRetry(() =>
          prisma.downloadSnapshot.update({
            where: { id: existing.id },
            data: {
              renderedHtml: finalHtml,
              snapshotData: snapshotData || {},
              expiresAt,
            },
          })
        );
      } else {
        snap = await withRetry(() =>
          prisma.downloadSnapshot.create({
            data: {
              name: customerName || 'Biodata',
              format: (format || 'PDF').toUpperCase(),
              templateId: templateId || null,
              orderId,
              snapshotData: snapshotData || {},
              renderedHtml: finalHtml,
              expiresAt,
            },
          })
        );
      }
      return snap;
    };

    let snap = null;
    try {
      snap = await Promise.race([
        dbSaveOperation(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Snapshot DB save timeout (3500ms)')), 3500)),
      ]);
    } catch (dbErr) {
      app?.log?.warn?.('[Cashfree Snapshot Save] DB save timed out or failed (non-blocking):', dbErr.message);
    }

    if (redis && redis.status === 'ready') {
      await redis.set(
        `snapshot:${orderId}`,
        JSON.stringify({
          id: snap.id,
          name: snap.name,
          format: snap.format,
          templateId,
          orderId,
          snapshotData,
          renderedHtml: finalHtml,
          expiresAt: expiresAt.toISOString(),
        }),
        'EX',
        86400
      ).catch(() => {});
    }

    return snap;
  } catch (snapErr) {
    app?.log?.warn?.('[Cashfree Snapshot Save] Warning:', snapErr.message);
    return null;
  }
}

export default async function cashfreeRoutes(app, options) {
  // 1. GET /api/cashfree/config
  app.get('/api/cashfree/config', async (request, reply) => {
    const config = getCashfreeConfig();
    return reply.send({
      success: true,
      gateway: 'cashfree',
      isConfigured: config.isConfigured,
      isSandbox: !config.isProduction,
      appId: config.isConfigured ? config.appId : null,
    });
  });

  // 1.5 GET /api/cashfree/active-coupons (Cached 5 mins via L1 memory + L2 Redis)
  app.get('/api/cashfree/active-coupons', async (request, reply) => {
    try {
      const validCoupons = await getCachedOrFetch('active-coupons', 300, async () => {
        const coupons = await withRetry(() =>
          prisma.coupon.findMany({
            where: {
              active: true,
              isPublic: true,
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: new Date() } },
              ],
            },
            orderBy: { createdAt: 'desc' },
          })
        );
        return coupons.filter(
          (c) => c.maxUses === null || c.usedCount < c.maxUses
        );
      });
      return reply.send({ success: true, coupons: validCoupons });
    } catch (error) {
      app.log.error('Cashfree GET active coupons error:', error);
      return reply.status(500).send({ error: 'Failed to fetch active coupons' });
    }
  });

  // 1.6 POST /api/cashfree/validate-coupon (Instant 1-2ms cache verification)
  app.post('/api/cashfree/validate-coupon', async (request, reply) => {
    try {
      const { code } = request.body || {};
      if (!code) {
        return reply.status(400).send({ error: 'Coupon code is required' });
      }

      const cleanCode = code.trim().toUpperCase();
      const coupon = await getCachedOrFetch(`coupon:${cleanCode}`, 300, async () => {
        return withRetry(() =>
          prisma.coupon.findUnique({
            where: { code: cleanCode },
          })
        );
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
      app.log.error('Cashfree Coupon Validation Error:', error);
      return reply.status(500).send({ error: 'Failed to validate coupon', details: error.message });
    }
  });

  // 2. POST /api/cashfree/create-order
  app.post('/api/cashfree/create-order', async (request, reply) => {
    try {
      const {
        amount,
        currency = 'INR',
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

      // Coupon discount calculation
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
          }
        }
      }

      // Minimum transaction amount for Indian Payment Gateways is ₹1.00
      const MIN_AMOUNT_INR = 1;
      if (finalAmount > 0 && finalAmount < MIN_AMOUNT_INR) {
        finalAmount = MIN_AMOUNT_INR;
      }

      // Free Order Flow (100% discount coupons)
      if (finalAmount <= 0) {
        const freeOrderId = `free_promo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        await withRetry(() =>
          prisma.order.create({
            data: {
              razorpayOrderId: freeOrderId, // reused as primary order identifier
              razorpayPaymentId: `free_cashfree_${Date.now()}`,
              razorpaySignature: 'free_checkout_signature',
              amount: 0,
              currency,
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

        // Increment coupon used count for 100% discount promo orders
        if (couponCode) {
          const cleanCoupon = couponCode.trim().toUpperCase();
          withRetry(() =>
            prisma.coupon.updateMany({
              where: { code: cleanCoupon },
              data: { usedCount: { increment: 1 } },
            })
          ).catch(() => {});
        }

        const snapshotHtml = html || renderedHtml;
        if (snapshotHtml) {
          saveDownloadSnapshotHelper({
            orderId: freeOrderId,
            customerName,
            format,
            templateId,
            snapshotData,
            snapshotHtml,
            app,
          }).catch(() => {});
        }

        return reply.send({
          success: true,
          isFreeOrder: true,
          order: {
            id: freeOrderId,
            amount: 0,
            currency,
          },
        });
      }

      const config = getCashfreeConfig();
      const orderId = `cf_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

      // Pre-save snapshot if provided directly (non-blocking fire-and-forget)
      const snapshotHtml = html || renderedHtml;
      if (snapshotHtml) {
        saveDownloadSnapshotHelper({
          orderId,
          customerName,
          format,
          templateId,
          snapshotData,
          snapshotHtml,
          app,
        }).catch(() => {});
      }

      // If Cashfree keys are not configured yet, offer the simulated sandbox mode
      if (!config.isConfigured) {
        await withRetry(() =>
          prisma.order.create({
            data: {
              razorpayOrderId: orderId,
              amount: finalAmount,
              currency,
              status: 'pending',
              format,
              templateId,
              customerName: customerName || null,
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              couponCode: couponCode || null,
              discountApplied,
              referralCode: ref || null,
            },
          })
        );

        return reply.send({
          success: true,
          isSandbox: true,
          isSimulator: true,
          order: {
            id: orderId,
            amount: finalAmount,
            currency,
          },
          message: 'Cashfree is running in simulation mode. Configure CASHFREE_APP_ID & CASHFREE_SECRET_KEY in backend/.env for live/sandbox checkout.',
        });
      }

      // Determine return URL and return path for redirect checkout
      const originHeader = request.headers.origin || request.headers.referer || 'https://biodata99.com';
      const cleanOrigin = originHeader.split('/api')[0].replace(/\/+$/, '');

      let returnPath = '/';
      if (request.body?.returnPath && typeof request.body.returnPath === 'string' && request.body.returnPath.startsWith('/')) {
        returnPath = request.body.returnPath;
      } else if (request.headers.referer) {
        try {
          const refUrl = new URL(request.headers.referer);
          if (refUrl.pathname && refUrl.pathname !== '/') {
            returnPath = refUrl.pathname;
          }
        } catch {}
      }

      // Backend callback URL that verifies the order and then redirects to the frontend
      const proto = request.headers['x-forwarded-proto'] || (config.isProduction ? 'https' : 'http');
      const fallbackHost = request.headers.host || '127.0.0.1:4000';
      let serverBaseUrl = process.env.API_BASE_URL || `${proto}://${fallbackHost}`;
      // In production or on live domains, Cashfree strictly enforces HTTPS on return_url
      if (config.isProduction || (!serverBaseUrl.includes('localhost') && !serverBaseUrl.includes('127.0.0.1'))) {
        serverBaseUrl = serverBaseUrl.replace(/^http:\/\//i, 'https://');
      }
      const returnUrl = `${serverBaseUrl}/api/cashfree/callback?order_id={order_id}&client_origin=${encodeURIComponent(cleanOrigin)}&return_path=${encodeURIComponent(returnPath)}`;
      const notifyUrl = `${serverBaseUrl}/api/cashfree/webhook`;

      // Parallel DB write + Cashfree API call for ultra-fast response
      const [dbOrder, cashfreeOrder] = await Promise.all([
        withRetry(() =>
          prisma.order.create({
            data: {
              razorpayOrderId: orderId, // stored in primary order reference
              amount: finalAmount,
              currency,
              status: 'pending',
              format,
              templateId,
              customerName: customerName || null,
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              couponCode: couponCode || null,
              discountApplied,
              referralCode: ref || null,
            },
          })
        ),
        createCashfreeOrder({
          orderId,
          orderAmount: finalAmount,
          orderCurrency: currency,
          customerDetails: {
            customer_id: customerPhone ? `cust_${customerPhone.slice(-10)}` : `cust_${Date.now()}`,
            customer_phone: customerPhone || '',
          },
          orderMeta: {
            return_url: returnUrl,
            notify_url: notifyUrl,
          },
          orderNote: `Biodata download: ${format.toUpperCase()}`,
        }),
      ]);

      return reply.send({
        success: true,
        isSandbox: !config.isProduction,
        isSimulator: false,
        order: {
          id: orderId,
          amount: finalAmount,
          currency,
        },
        paymentSessionId: cashfreeOrder.payment_session_id,
        cfOrderId: cashfreeOrder.cf_order_id,
      });
    } catch (error) {
      app.log.error('[Cashfree] Create Order Error:', error);

      // Clean up orphaned pending order on Cashfree order creation failure
      if (typeof orderId !== 'undefined' && orderId) {
        withRetry(() =>
          prisma.order.updateMany({
            where: { razorpayOrderId: orderId, status: 'pending' },
            data: {
              status: 'failed',
              downloadErrorMsg: String(error?.message || 'Cashfree session creation failed').slice(0, 500),
            },
          })
        ).catch(() => {});
      }

      return reply.status(500).send({ error: 'Failed to create Cashfree order', details: error.message });
    }
  });

  // 2.5 POST /api/cashfree/save-snapshot (Ultra-fast non-blocking background snapshot)
  app.post('/api/cashfree/save-snapshot', async (request, reply) => {
    try {
      const {
        orderId,
        html,
        renderedHtml,
        snapshotData,
        customerName,
        format,
        templateId,
        isGzipped,
      } = request.body || {};

      if (!orderId) {
        return reply.status(400).send({ error: 'orderId is required' });
      }

      const snapshotHtml = html || renderedHtml;
      if (!snapshotHtml) {
        return reply.send({ success: true, message: 'No html content provided' });
      }

      // 1. Immediately acknowledge 200 OK in ~5ms so client download is never blocked
      reply.status(200).send({ success: true, accepted: true });

      // 2. Fire-and-forget save to Redis + PostgreSQL in background
      (async () => {
        try {
          await Promise.race([
            saveDownloadSnapshotHelper({
              orderId,
              customerName,
              format,
              templateId,
              snapshotData,
              snapshotHtml,
              isGzipped,
              app,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Background snapshot timeout')), 5000)),
          ]);
        } catch (bgErr) {
          app.log.warn('[Cashfree Snapshot Save Background] Warning:', bgErr.message);
        }
      })();
    } catch (err) {
      app.log.warn('[Cashfree Snapshot Save] Error:', err.message);
      return reply.status(500).send({ error: 'Failed to save snapshot', details: err.message });
    }
  });

  // 3. GET /api/cashfree/order-status/:orderId
  app.get('/api/cashfree/order-status/:orderId', async (request, reply) => {
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

      if (order.status === 'paid') {
        return reply.send({
          success: true,
          status: 'paid',
          order: {
            id: order.id,
            orderId: order.razorpayOrderId,
            status: order.status,
            format: order.format,
            customerName: order.customerName,
          },
        });
      }

      // Query Cashfree API directly if order is pending
      const config = getCashfreeConfig();
      if (config.isConfigured && !order.razorpayOrderId.startsWith('mock_')) {
        try {
          const cfOrder = await getCashfreeOrderStatus(order.razorpayOrderId);
          if (cfOrder && cfOrder.order_status === 'PAID') {
            const payments = await getCashfreeOrderPayments(order.razorpayOrderId);
            const successfulPayment = payments.find((p) => p.payment_status === 'SUCCESS') || payments[0];

            const contactUpdate = {};
            if (cfOrder.customer_details?.customer_email) {
              contactUpdate.customerEmail = cfOrder.customer_details.customer_email;
            }
            if (cfOrder.customer_details?.customer_phone) {
              contactUpdate.customerPhone = cfOrder.customer_details.customer_phone;
            }

            order = await withRetry(() =>
              prisma.order.update({
                where: { id: order.id },
                data: {
                  status: 'paid',
                  razorpayPaymentId: successfulPayment?.cf_payment_id ? String(successfulPayment.cf_payment_id) : `cf_pay_${Date.now()}`,
                  razorpaySignature: successfulPayment?.payment_group || 'cashfree_verified',
                  ...contactUpdate,
                },
              })
            );

            // Increment coupon usage count
            if (order.couponCode) {
              withRetry(() =>
                prisma.coupon.updateMany({
                  where: { code: order.couponCode },
                  data: { usedCount: { increment: 1 } },
                })
              ).catch((e) => app.log.warn('[Cashfree Status] Coupon update failed:', e.message));
            }

            // Affiliate commission
            if (order.referralCode) {
              createCommissionForOrder(order, app).catch((e) =>
                app.log.warn('[Cashfree Status] Commission error:', e.message)
              );
            }

            if (redis && redis.status === 'ready') {
              redis.del('admin:dashboard-stats').catch(() => { });
            }

            return reply.send({
              success: true,
              status: 'paid',
              order: {
                id: order.id,
                orderId: order.razorpayOrderId,
                status: 'paid',
                format: order.format,
                customerName: order.customerName,
              },
            });
          } else if (cfOrder) {
            const payments = await getCashfreeOrderPayments(order.razorpayOrderId).catch(() => []);
            const droppedPay = payments.find((p) => ['USER_DROPPED', 'CANCELLED'].includes(p.payment_status));
            const failedPay = payments.find((p) => ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(p.payment_status));
            const isExplicitlyCancelled = cfOrder.order_status === 'CANCELLED' || Boolean(droppedPay);
            const isTerminatedOrExpired = ['EXPIRED', 'TERMINATED'].includes(cfOrder.order_status);

            if (isExplicitlyCancelled || isTerminatedOrExpired || (failedPay && failedPay.payment_status === 'FAILED')) {
              const finalStatus = isExplicitlyCancelled ? 'cancelled' : 'failed';
              const failureReason = droppedPay?.payment_message || failedPay?.payment_message || (isExplicitlyCancelled ? 'Payment cancelled by user' : `Order ${cfOrder.order_status.toLowerCase()}`);

              await withRetry(() =>
                prisma.order.updateMany({
                  where: { id: order.id, status: { not: 'paid' } },
                  data: {
                    status: finalStatus,
                    downloadErrorMsg: String(failureReason).slice(0, 500),
                  },
                })
              ).catch(() => { });

              return reply.send({
                success: true,
                status: finalStatus,
                error: failureReason,
                order: {
                  id: order.id,
                  orderId: order.razorpayOrderId,
                  status: finalStatus,
                  format: order.format,
                },
              });
            }
          }
        } catch (queryErr) {
          app.log.warn(`[Cashfree Status] Query warning for ${order.razorpayOrderId}:`, queryErr.message);
        }
      }

      return reply.send({
        success: true,
        status: order.status || 'pending',
        order: {
          id: order.id,
          orderId: order.razorpayOrderId,
          status: order.status,
          format: order.format,
        },
      });
    } catch (error) {
      app.log.error('Cashfree order status error:', error);
      return reply.status(500).send({ error: 'Failed to fetch order status' });
    }
  });

  // 4. GET & POST /api/cashfree/callback (Redirect endpoint after Cashfree checkout)
  app.route({
    method: ['GET', 'POST'],
    url: '/api/cashfree/callback',
    handler: async (request, reply) => {
      let clientUrl = process.env.CLIENT_URL || 'https://biodata99.com';
      try {
        const body = request.body || {};
        const query = request.query || {};

        const candidateOrigin = query.client_origin || body.client_origin;
        if (candidateOrigin) {
          try {
            const parsed = new URL(candidateOrigin);
            if (
              parsed.hostname === 'biodata99.com' ||
              parsed.hostname.endsWith('.biodata99.com') ||
              parsed.hostname === 'localhost' ||
              parsed.hostname === '127.0.0.1' ||
              parsed.hostname.startsWith('192.168.') ||
              parsed.hostname.startsWith('10.') ||
              parsed.hostname.startsWith('172.')
            ) {
              clientUrl = candidateOrigin.replace(/\/+$/, '');
            }
          } catch { }
        }

        let returnPath = '/';
        const candidatePath = query.return_path || body.return_path;
        if (candidatePath && typeof candidatePath === 'string' && candidatePath.startsWith('/')) {
          returnPath = candidatePath;
        }

        const orderId = query.order_id || body.order_id;
        if (!orderId) {
          return reply.redirect(`${clientUrl}/payment-processing?status=failed&error=Missing%20Order%20ID`, 303);
        }

        const config = getCashfreeConfig();
        let isPaid = false;
        let paymentId = '';

        if (config.isConfigured) {
          // Retry loop: UPI app-switch payments (PhonePe, GPay) may take a few seconds
          // for Cashfree to mark as PAID after the redirect fires. Retry up to 5 times.
          const MAX_STATUS_ATTEMPTS = 5;
          const STATUS_RETRY_DELAY_MS = 2000;

          for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt++) {
            try {
              const cfOrder = await getCashfreeOrderStatus(orderId);
              if (cfOrder && cfOrder.order_status === 'PAID') {
                isPaid = true;
                const payments = await getCashfreeOrderPayments(orderId);
                const successPay = payments.find((p) => p.payment_status === 'SUCCESS');
                paymentId = successPay?.cf_payment_id ? String(successPay.cf_payment_id) : `cf_paid_${Date.now()}`;
                break; // confirmed PAID — exit retry loop
              }

              // Check payment status — but don't break early on USER_DROPPED alone:
              // UPI payments (PhonePe, GPay) can briefly show USER_DROPPED before settling as SUCCESS.
              const payments = await getCashfreeOrderPayments(orderId).catch(() => []);
              const hasSuccessPayment = payments.some((p) => p.payment_status === 'SUCCESS');
              if (hasSuccessPayment) {
                // A successful payment exists — this order will settle; keep retrying to confirm PAID status
                app.log.info(`[Cashfree Callback] Order ${orderId} has a SUCCESS payment alongside non-PAID status — continuing retries`);
              } else {
                const droppedPay = payments.find((p) => p.payment_status === 'USER_DROPPED');
                const cancelledPay = payments.find((p) => p.payment_status === 'CANCELLED');
                // Only break early if payment is definitively cancelled AND there's no success payment
                // Give USER_DROPPED one more retry cycle since UPI can recover
                if (cancelledPay) {
                  app.log.info(`[Cashfree Callback] Order ${orderId} payment is CANCELLED — breaking retry loop`);
                  break;
                }
                if (droppedPay && attempt >= 1) {
                  // Only bail on USER_DROPPED after at least one retry (not immediately on first attempt)
                  app.log.info(`[Cashfree Callback] Order ${orderId} payment is USER_DROPPED after ${attempt + 1} attempts — breaking retry loop`);
                  break;
                }
              }

              // If order is explicitly CANCELLED/TERMINATED, stop retrying early
              if (cfOrder && (cfOrder.order_status === 'CANCELLED' || cfOrder.order_status === 'TERMINATED' || cfOrder.order_status === 'EXPIRED')) {
                app.log.info(`[Cashfree Callback] Order ${orderId} status: ${cfOrder.order_status} — stopping retries`);
                break;
              }

              app.log.info(`[Cashfree Callback] Attempt ${attempt + 1}/${MAX_STATUS_ATTEMPTS}: order ${orderId} status=${cfOrder?.order_status || 'unknown'}, retrying in ${STATUS_RETRY_DELAY_MS}ms...`);
            } catch (cfErr) {
              app.log.error(`[Cashfree Callback] Attempt ${attempt + 1} error querying order status:`, cfErr);
            }

            if (attempt < MAX_STATUS_ATTEMPTS - 1) {
              await new Promise((r) => setTimeout(r, STATUS_RETRY_DELAY_MS));
            }
          }
        }

        if (isPaid) {
          const updatedOrder = await withRetry(() =>
            prisma.order.update({
              where: { razorpayOrderId: orderId },
              data: {
                status: 'paid',
                razorpayPaymentId: paymentId || `cf_paid_${Date.now()}`,
                razorpaySignature: 'cashfree_redirect_verified',
              },
            })
          ).catch((e) => app.log.warn('[Cashfree Callback] Order DB update warn:', e.message));

          if (updatedOrder?.couponCode) {
            withRetry(() =>
              prisma.coupon.updateMany({
                where: { code: updatedOrder.couponCode },
                data: { usedCount: { increment: 1 } },
              })
            ).catch(() => { });
          }

          if (updatedOrder?.referralCode) {
            createCommissionForOrder(updatedOrder, app).catch(() => { });
          }

          return reply.redirect(
            `${clientUrl}/payment-processing?order_id=${encodeURIComponent(orderId)}&status=success`,
            303
          );
        } else {
          // Extract specific failure or cancellation reason from Cashfree payments
          let failureReason = 'Payment was cancelled or could not be completed';
          let finalStatus = 'failed';
          let isCancelled = false;

          const queryError = (query.error || body.error || '').toLowerCase();
          if (queryError.includes('cancel') || queryError.includes('drop')) {
            finalStatus = 'cancelled';
            isCancelled = true;
          }

          if (config.isConfigured) {
            try {
              const cfOrder = await getCashfreeOrderStatus(orderId).catch(() => null);
              const payments = await getCashfreeOrderPayments(orderId).catch(() => []);

              // CRITICAL: Always check for a SUCCESS payment first.
              // UPI payments can show USER_DROPPED briefly before settling successfully.
              const successPay = payments.find((p) => p.payment_status === 'SUCCESS');
              if (successPay || cfOrder?.order_status === 'PAID') {
                // Payment actually succeeded — override isPaid and redirect to success
                app.log.info(`[Cashfree Callback] Order ${orderId} has SUCCESS payment despite non-PAID redirect — correcting to paid`);
                const payId = successPay?.cf_payment_id ? String(successPay.cf_payment_id) : `cf_paid_${Date.now()}`;
                await withRetry(() =>
                  prisma.order.update({
                    where: { razorpayOrderId: orderId },
                    data: {
                      status: 'paid',
                      razorpayPaymentId: payId,
                      razorpaySignature: 'cashfree_redirect_verified',
                    },
                  })
                ).catch((e) => app.log.warn('[Cashfree Callback] Corrected paid update warn:', e.message));
                return reply.redirect(
                  `${clientUrl}/payment-processing?order_id=${encodeURIComponent(orderId)}&status=success`,
                  303
                );
              }

              const droppedPay = payments.find((p) => p.payment_status === 'USER_DROPPED');
              const cancelledPay = payments.find((p) => p.payment_status === 'CANCELLED');
              const failedPay = payments.find((p) => p.payment_status === 'FAILED') || payments[0];

              if (cancelledPay) {
                finalStatus = 'cancelled';
                isCancelled = true;
                failureReason = cancelledPay.payment_message || 'Transaction was cancelled by user';
              } else if (droppedPay) {
                finalStatus = 'cancelled';
                isCancelled = true;
                failureReason = droppedPay.payment_message || 'Transaction was cancelled by user';
              } else if (cfOrder?.order_status === 'CANCELLED' || cfOrder?.order_status === 'TERMINATED') {
                finalStatus = 'cancelled';
                isCancelled = true;
                failureReason = 'Order was cancelled';
              } else if (failedPay && failedPay.payment_status === 'FAILED') {
                failureReason = failedPay.payment_message || failedPay.error_details?.error_description || failedPay.error_details?.error_reason || 'Payment failed';
              } else if (cfOrder && cfOrder.order_status === 'ACTIVE') {
                // Check if any payment is genuinely PENDING settlement (UPI app switch)
                const hasPendingPay = payments.some((p) => p.payment_status === 'PENDING');
                if (hasPendingPay) {
                  app.log.info(`[Cashfree Callback] Order ${orderId} has PENDING payment. Redirecting to confirming state for client polling.`);
                  return reply.redirect(
                    `${clientUrl}/payment-processing?order_id=${encodeURIComponent(orderId)}&status=confirming`,
                    303
                  );
                } else {
                  // Order is ACTIVE on Cashfree but user returned via return_url without paying -> user exited/cancelled
                  finalStatus = 'cancelled';
                  isCancelled = true;
                  failureReason = 'Payment checkout was cancelled';
                }
              }
            } catch (cfErr) {
              app.log.warn('[Cashfree Callback] Error inspecting payments:', cfErr);
            }
          }

          // Mark order in backend database as 'cancelled' or 'failed' (if not already paid)
          await withRetry(() =>
            prisma.order.updateMany({
              where: { razorpayOrderId: orderId, status: { not: 'paid' } },
              data: {
                status: finalStatus,
                downloadErrorMsg: String(failureReason).slice(0, 500),
              },
            })
          ).catch((e) => app.log.warn('[Cashfree Callback] Order status DB update warn:', e.message));

          if (redis && redis.status === 'ready') {
            try {
              const keys = await redis.keys('transactions:*');
              if (keys.length > 0) await redis.del(keys);
              await redis.del('admin:dashboard-stats');
            } catch { }
          }

          if (isCancelled || finalStatus === 'cancelled') {
            app.log.info(`[Cashfree Callback] Order ${orderId} cancelled by user. Redirecting directly to ${returnPath}.`);
            const separator = returnPath.includes('?') ? '&' : '?';
            return reply.redirect(`${clientUrl}${returnPath}${separator}cancelled=1`, 303);
          }

          return reply.redirect(
            `${clientUrl}/payment-processing?order_id=${encodeURIComponent(orderId)}&status=${finalStatus}&error=${encodeURIComponent(failureReason)}`,
            303
          );
        }
      } catch (err) {
        app.log.error('[Cashfree Callback] Unexpected error:', err);
        return reply.redirect(`${clientUrl}/payment-processing?status=failed&error=${encodeURIComponent(err.message)}`, 303);
      }
    },
  });

  // 5. POST /api/cashfree/verify-payment (For frontend drop/component verification)
  app.post('/api/cashfree/verify-payment', async (request, reply) => {
    try {
      const { orderId, isSandbox } = request.body || {};

      if (!orderId) {
        return reply.status(400).send({ error: 'Order ID is required' });
      }

      // Simulated sandbox verification
      if (isSandbox || orderId.startsWith('mock_') || orderId.startsWith('cf_sim_')) {
        const updatedOrder = await withRetry(() =>
          prisma.order.update({
            where: { razorpayOrderId: orderId },
            data: {
              status: 'paid',
              razorpayPaymentId: `sim_cf_pay_${Date.now()}`,
              razorpaySignature: 'simulator_verified',
            },
          })
        );

        if (updatedOrder.referralCode) {
          await createCommissionForOrder(updatedOrder, app);
        }

        return reply.send({
          success: true,
          message: 'Simulated payment verified successfully',
          order: updatedOrder,
        });
      }

      // Verify with Cashfree API
      const cfOrder = await getCashfreeOrderStatus(orderId);
      if (!cfOrder || cfOrder.order_status !== 'PAID') {
        return reply.status(400).send({
          error: 'Payment not completed or failed on Cashfree',
          orderStatus: cfOrder?.order_status,
        });
      }

      const payments = await getCashfreeOrderPayments(orderId);
      const successfulPayment = payments.find((p) => p.payment_status === 'SUCCESS');

      const updatedOrder = await withRetry(() =>
        prisma.order.update({
          where: { razorpayOrderId: orderId },
          data: {
            status: 'paid',
            razorpayPaymentId: successfulPayment?.cf_payment_id ? String(successfulPayment.cf_payment_id) : `cf_pay_${Date.now()}`,
            razorpaySignature: 'cashfree_verified',
          },
        })
      );

      if (updatedOrder.couponCode) {
        withRetry(() =>
          prisma.coupon.updateMany({
            where: { code: updatedOrder.couponCode },
            data: { usedCount: { increment: 1 } },
          })
        ).catch(() => { });
      }

      if (updatedOrder.referralCode) {
        await createCommissionForOrder(updatedOrder, app);
      }

      return reply.send({
        success: true,
        message: 'Cashfree payment verified successfully',
        order: updatedOrder,
      });
    } catch (err) {
      app.log.error('[Cashfree Verify Payment] Error:', err);
      return reply.status(500).send({ error: 'Failed to verify Cashfree payment', details: err.message });
    }
  });

  // 6. POST /api/cashfree/webhook (Cashfree server-to-server notifications)
  app.post('/api/cashfree/webhook', async (request, reply) => {
    try {
      const signature = request.headers['x-webhook-signature'];
      const timestamp = request.headers['x-webhook-timestamp'];
      const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);

      // Verify signature if provided
      if (signature && timestamp) {
        const isValid = verifyCashfreeWebhookSignature(signature, rawBody, timestamp);
        if (!isValid) {
          app.log.warn('[Cashfree Webhook] Invalid signature received');
          return reply.status(400).send({ error: 'Invalid webhook signature' });
        }
      }

      const event = typeof request.body === 'object' ? request.body : JSON.parse(request.body || '{}');
      const orderData = event.data?.order || event.order;
      const paymentData = event.data?.payment || event.payment;

      if (orderData?.order_id && (orderData.order_status === 'PAID' || paymentData?.payment_status === 'SUCCESS')) {
        const orderId = orderData.order_id;
        await withRetry(() =>
          prisma.order.updateMany({
            where: { razorpayOrderId: orderId, status: { not: 'paid' } },
            data: {
              status: 'paid',
              razorpayPaymentId: paymentData?.cf_payment_id ? String(paymentData.cf_payment_id) : `cf_hook_${Date.now()}`,
              razorpaySignature: 'cashfree_webhook_verified',
            },
          })
        );
      } else if (
        orderData?.order_id &&
        (paymentData?.payment_status === 'FAILED' ||
          paymentData?.payment_status === 'USER_DROPPED' ||
          paymentData?.payment_status === 'CANCELLED' ||
          orderData?.order_status === 'EXPIRED' ||
          orderData?.order_status === 'TERMINATED' ||
          orderData?.order_status === 'CANCELLED')
      ) {
        const orderId = orderData.order_id;
        const isCancelled =
          paymentData?.payment_status === 'USER_DROPPED' ||
          paymentData?.payment_status === 'CANCELLED' ||
          orderData?.order_status === 'CANCELLED';

        const finalStatus = isCancelled ? 'cancelled' : 'failed';
        const failureReason =
          paymentData?.payment_message ||
          paymentData?.error_details?.error_description ||
          paymentData?.error_details?.error_reason ||
          `Order ${orderData.order_status || finalStatus}`;

        await withRetry(() =>
          prisma.order.updateMany({
            where: { razorpayOrderId: orderId, status: { not: 'paid' } },
            data: {
              status: finalStatus,
              downloadErrorMsg: String(failureReason).slice(0, 500),
            },
          })
        ).catch(() => { });

        if (redis && redis.status === 'ready') {
          try {
            const keys = await redis.keys('transactions:*');
            if (keys.length > 0) await redis.del(keys);
            await redis.del('admin:dashboard-stats');
          } catch { }
        }
      }

      return reply.send({ success: true, message: 'Webhook received' });
    } catch (err) {
      app.log.error('[Cashfree Webhook] Error processing webhook:', err);
      return reply.status(200).send({ success: false }); // Always return 200 to webhook caller
    }
  });

  // 7. POST /api/cashfree/update-download-status
  app.post('/api/cashfree/update-download-status', async (request, reply) => {
    try {
      const { orderId, downloadStatus, errorMsg } = request.body || {};

      if (!orderId || !downloadStatus) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      const VALID_STATUSES = ['success', 'failed', 'pending'];
      if (!VALID_STATUSES.includes(downloadStatus)) {
        return reply.status(400).send({ error: `Invalid downloadStatus value: ${downloadStatus}` });
      }

      if (orderId === 'sandbox' || orderId === 'dev_bypass') {
        return reply.send({ success: true, message: 'Sandbox/dev skipped' });
      }

      try {
        const updateData = { downloadStatus };
        if (errorMsg && downloadStatus === 'failed') {
          updateData.downloadErrorMsg = String(errorMsg).slice(0, 500);
        }
        await prisma.order.update({
          where: { razorpayOrderId: orderId },
          data: updateData,
        });
      } catch (dbErr) {
        app.log.warn('[Cashfree update-download-status] DB update failed:', dbErr.message);
      }

      return reply.send({ success: true });
    } catch (err) {
      app.log.error('Cashfree update download status error:', err);
      return reply.status(200).send({ success: false });
    }
  });

  // 8. POST /api/cashfree/mark-failed (Explicit endpoint to mark failed or cancelled orders in DB)
  app.post('/api/cashfree/mark-failed', async (request, reply) => {
    try {
      const { orderId, errorMsg, status: requestedStatus } = request.body || {};
      if (!orderId) {
        return reply.status(400).send({ error: 'Order ID is required' });
      }

      if (orderId === 'sandbox' || orderId === 'dev_bypass') {
        return reply.send({ success: true, message: 'Sandbox/dev skipped' });
      }

      const existing = await prisma.order.findFirst({
        where: {
          OR: [{ razorpayOrderId: orderId }, { id: orderId }],
        },
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Order not found' });
      }

      // CRITICAL: Never overwrite an order that has already been verified as paid!
      if (existing.status === 'paid') {
        return reply.send({ success: false, message: 'Order is already marked paid' });
      }

      // Query Cashfree API to extract specific gateway error/message if available
      let finalReason = errorMsg || 'Payment was cancelled or failed at gateway';
      let finalStatus = requestedStatus === 'cancelled' ? 'cancelled' : 'failed';

      const config = getCashfreeConfig();
      if (config.isConfigured && !orderId.startsWith('mock_')) {
        try {
          const payments = await getCashfreeOrderPayments(existing.razorpayOrderId).catch(() => []);
          const failedPayment = payments.find((p) => ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(p.payment_status)) || payments[0];
          if (failedPayment) {
            finalReason =
              failedPayment.payment_message ||
              failedPayment.error_details?.error_description ||
              failedPayment.error_details?.error_reason ||
              finalReason;
            if (failedPayment.payment_status === 'USER_DROPPED' || failedPayment.payment_status === 'CANCELLED') {
              finalStatus = 'cancelled';
            }
          }
        } catch { }
      }

      const reasonLower = (finalReason || '').toLowerCase();
      if (reasonLower.includes('cancel') || reasonLower.includes('drop')) {
        finalStatus = 'cancelled';
      }

      const updated = await withRetry(() =>
        prisma.order.update({
          where: { id: existing.id },
          data: {
            status: finalStatus,
            downloadErrorMsg: String(finalReason).slice(0, 500),
          },
        })
      );

      if (redis && redis.status === 'ready') {
        try {
          const keys = await redis.keys('transactions:*');
          if (keys.length > 0) await redis.del(keys);
          await redis.del('admin:dashboard-stats');
        } catch { }
      }

      app.log.info(`[Cashfree Mark Status] Order ${existing.razorpayOrderId} marked as ${finalStatus}: ${finalReason}`);
      return reply.send({ success: true, order: updated, status: finalStatus, reason: finalReason });
    } catch (err) {
      app.log.error('Cashfree mark failed error:', err);
      return reply.status(500).send({ error: 'Failed to update order status', details: err.message });
    }
  });
}

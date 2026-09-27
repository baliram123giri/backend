import { prisma } from '../../lib/prisma.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import sharp from 'sharp';
import { getCachedOrFetch, redis } from '../../lib/redis.js';

const SETTINGS_CACHE_KEY = "admin:review-settings";
const contactAttachments = new Map();
let lastContactInquiry = null;

export default async function routes(app, options) {
app.get('/api/bootstrap', async (request, reply) => {
  try {
    const data = await getCachedOrFetch('app:bootstrap', 300, async () => {
      const [dbBackgrounds, dbReviewSettings] = await Promise.all([
        prisma.background.findMany({
          orderBy: { createdAt: 'desc' },
          take: 100
        }),
        prisma.reviewSettings.upsert({
          where: { id: "global" },
          update: {},
          create: {
            id: "global",
            googleEnabled: true,
            googleRating: 4.9,
            googleCount: 524,
            googleUrl: "https://share.google/T4eEjxMJkqDKaFWGN",
            trustpilotEnabled: true,
            trustpilotRating: 4.8,
            trustpilotCount: 320,
            trustpilotUrl: "https://www.trustpilot.com/review/biodata99.com",
          }
        })
      ]);

      return {
        backgrounds: dbBackgrounds,
        reviewSettings: dbReviewSettings
      };
    });

    return reply.send({ success: true, ...data });
  } catch (error) {
    app.log.error('GET Bootstrap Error:', error);
    return reply.status(500).send({ success: false, error: 'Failed to bootstrap application data' });
  }
});

app.get('/api/review-settings', async (request, reply) => {
  try {
    const settings = await getCachedOrFetch(SETTINGS_CACHE_KEY, 3600, async () => {
      return prisma.reviewSettings.upsert({
        where: { id: "global" },
        update: {},
        create: {
          id: "global",
          googleEnabled: true,
          googleRating: 4.9,
          googleCount: 524,
          googleUrl: "https://share.google/T4eEjxMJkqDKaFWGN",
          trustpilotEnabled: true,
          trustpilotRating: 4.8,
          trustpilotCount: 320,
          trustpilotUrl: "https://www.trustpilot.com/review/biodata99.com",
        }
      });
    });
    return reply.send({ success: true, settings });
  } catch (error) {
    app.log.error('GET Public Review Settings Error:', error);
    return reply.status(500).send({ error: 'Failed to fetch review settings' });
  }
});

app.post('/api/feedback', {
  schema: {
    body: {
      type: 'object',
      required: ['name', 'rating'],
      properties: {
        name: { type: 'string', minLength: 1 },
        rating: { type: 'number', minimum: 1, maximum: 5 },
        comment: { type: ['string', 'null'], nullable: true }
      }
    }
  }
}, async (request, reply) => {
  try {
    const { name, rating, comment } = request.body;

    const feedback = await prisma.feedback.create({
      data: {
        name,
        rating: Math.min(5, Math.max(1, rating)),
        comment: comment || null,
      },
    });

    if (redis && redis.status === 'ready') {
      try {
        await redis.del('admin:feedback');
        await redis.del('admin:dashboard-stats');
      } catch (cacheErr) {
        app.log.warn('Failed to invalidate feedback cache:', cacheErr);
      }
    }

    return { success: true, feedback };
  } catch (error) {
    app.log.error('Feedback Save Error:', error);
    reply.status(500).send({ error: 'Failed to save feedback', details: error.message });
  }
});

// -------------------------------------------------------------
// 7. POST /api/download-log
// -------------------------------------------------------------
  app.post('/api/download-log', async (request, reply) => {
    try {
      const { name, location, format, templateId, orderId, isFree, status, errorMsg, dob, snapshotData, renderedHtml } = request.body || {};

      const resolvedName = (typeof name === 'string' ? name.trim() : '') || 'Matrimonial Biodata';
      const resolvedFormat = (format || 'pdf').toUpperCase();
      const trimmedDob = typeof dob === 'string' ? dob.trim() : '';
      const trimmedLoc = typeof location === 'string' ? location.trim() : '';

      // Preserve actual customer location/address while encoding DOB tag for rate limiting
      let resolvedLocation = null;
      if (trimmedLoc && trimmedDob) {
        resolvedLocation = `${trimmedLoc} • DOB: ${trimmedDob}`;
      } else if (trimmedLoc) {
        resolvedLocation = trimmedLoc;
      } else if (trimmedDob) {
        resolvedLocation = `DOB: ${trimmedDob}`;
      }

      // Resolve orderId only if not explicitly a free download
      let resolvedOrderId = orderId || null;
      if (!isFree && !resolvedOrderId && resolvedName && templateId) {
        try {
          const matchingOrder = await prisma.order.findFirst({
            where: {
              customerName: { equals: resolvedName, mode: 'insensitive' },
              templateId: templateId,
              status: 'paid',
            },
            orderBy: {
              createdAt: 'desc',
            },
          });
          if (matchingOrder) {
            resolvedOrderId = matchingOrder.razorpayOrderId;
          }
        } catch (findErr) {
          console.warn('Failed to resolve missing order ID in download log:', findErr.message);
        }
      }

      const ipAddress =
        request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        request.headers['x-real-ip'] ||
        request.ip ||
        null;
      const userAgent = request.headers['user-agent'] || null;

      // Always create persistent download log in database (both Free and Paid)
      const log = await prisma.downloadLog.create({
        data: {
          name: resolvedName,
          location: resolvedLocation,
          format: resolvedFormat,
          templateId: templateId || null,
          ipAddress,
          userAgent,
          orderId: isFree ? null : (resolvedOrderId || null),
          errorMsg: errorMsg || null,
        },
      });

      // Save 24-hour snapshot if snapshotData or renderedHtml provided
      if (snapshotData || renderedHtml) {
        try {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          const snap = await prisma.downloadSnapshot.create({
            data: {
              name: resolvedName,
              format: resolvedFormat,
              templateId: templateId || null,
              orderId: isFree ? null : (resolvedOrderId || null),
              downloadLogId: log.id,
              snapshotData: snapshotData || {},
              renderedHtml: renderedHtml || null,
              expiresAt,
            },
          });
          if (redis && redis.status === 'ready') {
            await redis.set(
              `snapshot:${snap.id}`,
              JSON.stringify({
                id: snap.id,
                name: snap.name,
                format: resolvedFormat,
                templateId,
                orderId: isFree ? null : (resolvedOrderId || null),
                snapshotData,
                renderedHtml,
                expiresAt: expiresAt.toISOString(),
              }),
              'EX',
              86400
            ).catch(() => {});
          }
        } catch (snapErr) {
          console.warn('Failed to save snapshot in download-log:', snapErr.message);
        }
      } else {
        // Fallback: If snapshot wasn't passed directly, link any unlinked snapshot recently created
        try {
          const recentSnap = await prisma.downloadSnapshot.findFirst({
            where: {
              name: resolvedName,
              downloadLogId: null,
              createdAt: {
                gte: new Date(Date.now() - 5 * 60 * 1000),
              },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (recentSnap) {
            await prisma.downloadSnapshot.update({
              where: { id: recentSnap.id },
              data: { downloadLogId: log.id },
            }).catch(() => {});
          }
        } catch (linkErr) {
          console.warn('Failed to auto-link snapshot in download-log:', linkErr.message);
        }
      }

      // Invalidate dashboard stats & transaction caches
      if (redis && redis.status === 'ready') {
        try {
          await redis.del('admin:dashboard-stats');
          const txKeys = await redis.keys('transactions:*');
          if (txKeys.length > 0) {
            await redis.del(txKeys);
          }
          if (isFree && resolvedName) {
            const freeKeys = await redis.keys(`ratelimit:free_dl:${resolvedName.toLowerCase()}*`);
            if (freeKeys.length > 0) {
              await redis.del(freeKeys);
            }
          }
        } catch (cacheErr) {
          console.warn('Redis cache invalidation error on download log:', cacheErr.message);
        }
      }

      if (resolvedOrderId && resolvedOrderId !== 'sandbox' && resolvedOrderId !== 'dev_bypass') {
        try {
          await prisma.order.update({
            where: { razorpayOrderId: resolvedOrderId },
            data: { downloadStatus: status === 'failed' ? 'failed' : 'success' },
          });
        } catch (dbErr) {
          console.warn('Failed to update downloadStatus of order in download-log API:', dbErr.message);
        }
      }

      return { success: true, log };
    } catch (error) {
      app.log.error('Download log error:', error);
      reply.status(500).send({ error: 'Failed to record download', details: error.message });
    }
  });

// -------------------------------------------------------------
// 7.1 POST /api/check-free-download-limit
// -------------------------------------------------------------
  app.post('/api/check-free-download-limit', async (request, reply) => {
    try {
      const { name, dob } = request.body || {};

      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const trimmedDob = typeof dob === 'string' ? dob.trim() : '';

      // Limit check ONLY applies when BOTH Full Name and Date of Birth (DOB) exist
      if (!trimmedName || trimmedName.length < 2 || !trimmedDob || trimmedDob.length < 2) {
        return { success: true, count: 0, limit: 2, limitReached: false };
      }

      const cacheKey = `ratelimit:free_dl:${trimmedName.toLowerCase()}_${trimmedDob.toLowerCase()}`;

      // 1. Fast Redis check (1ms response)
      if (redis && redis.status === 'ready') {
        const cachedCount = await redis.get(cacheKey).catch(() => null);
        if (cachedCount !== null) {
          const count = parseInt(cachedCount, 10) || 0;
          const limitReached = count >= 2;
          return {
            success: true,
            count,
            limit: 2,
            limitReached,
            message: limitReached
              ? 'You have already downloaded free biodata 2 times. Please use a premium template or pay ₹20 for this template.'
              : null,
          };
        }
      }

      // 2. Database check: only count free downloads that match BOTH the exact name and DOB
      const matches = await prisma.$queryRaw`
        SELECT id FROM "DownloadLog"
        WHERE "orderId" IS NULL
          AND "errorMsg" IS NULL
          AND LOWER(TRIM("name")) = LOWER(${trimmedName})
          AND "location" ILIKE ${'%' + trimmedDob + '%'}
        LIMIT 2
      `;

      const count = matches.length;
      const limit = 2;
      const limitReached = count >= limit;

      // Cache count in Redis for 1 hour to keep subsequent clicks instantaneous
      if (redis && redis.status === 'ready') {
        await redis.set(cacheKey, String(count), 'EX', 3600).catch(() => {});
      }

      return {
        success: true,
        count,
        limit,
        limitReached,
        message: limitReached
          ? 'You have already downloaded free biodata 2 times. Please use a premium template or pay ₹20 for this template.'
          : null,
      };
    } catch (error) {
      app.log.error('Check free download limit error:', error);
      return { success: true, count: 0, limit: 2, limitReached: false };
    }
  });

// -------------------------------------------------------------
// 7.9 In-memory storage & endpoint for support attachments
// -------------------------------------------------------------
app.get('/api/contact/last-debug', async (request, reply) => {
  return reply.send({
    success: true,
    lastInquiry: lastContactInquiry,
    cachedAttachmentsCount: contactAttachments.size,
  });
});

app.get('/api/contact/attachment/:id', async (request, reply) => {
  const { id } = request.params;
  const item = contactAttachments.get(id);
  if (!item) {
    return reply.status(404).send('Attachment not found or expired.');
  }
  reply.header('Content-Type', item.contentType);
  reply.header('Content-Disposition', `inline; filename="${item.filename}"`);
  reply.header('Cache-Control', 'public, max-age=604800');
  return reply.send(item.buffer);
});

// Diagnostic endpoint: Sends a verified test email with attachment directly through Nodemailer
app.get('/api/contact/test-dispatch', async (request, reply) => {
  try {
    const smtpPass = process.env.EMAIL_PASS;
    const smtpHost = process.env.EMAIL_HOST || 'smtp.hostinger.com';
    const smtpPort = parseInt(process.env.EMAIL_PORT || '465');
    const smtpUser = process.env.EMAIL_USER || 'support@biodata99.com';

    if (!smtpPass) {
      return reply.send({ success: false, error: 'EMAIL_PASS not configured' });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { rejectUnauthorized: false },
    });

    const testImageBuffer = await sharp({
      create: {
        width: 320,
        height: 160,
        channels: 3,
        background: { r: 155, g: 27, b: 48 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const testAttachmentId = crypto.randomUUID();
    contactAttachments.set(testAttachmentId, {
      buffer: testImageBuffer,
      contentType: 'image/jpeg',
      filename: 'verification_screenshot.jpg',
      createdAt: Date.now(),
    });

    const testDirectUrl = `https://api.biodata99.com/api/contact/attachment/${testAttachmentId}`;

    const info = await transporter.sendMail({
      from: `"biodata99.com Diagnostic" <${smtpUser}>`,
      to: smtpUser,
      subject: `[Diagnostic] Support Attachment Verification - ${new Date().toLocaleTimeString('en-IN')}`,
      attachments: [
        {
          filename: 'verification_screenshot.jpg',
          content: testImageBuffer,
          contentType: 'image/jpeg',
          contentDisposition: 'attachment',
        },
        {
          filename: 'preview_verification_screenshot.jpg',
          content: testImageBuffer,
          contentType: 'image/jpeg',
          contentDisposition: 'inline',
          cid: 'support_attachment_preview',
        },
      ],
      html: `
        <div style="font-family: sans-serif; padding: 20px; background: #fff8f0; border: 1px solid #C9A84C; border-radius: 8px; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #9B1B30; margin-top: 0;">Support Attachment Verification Test</h2>
          <p style="font-size: 14px; color: #333;">This diagnostic verifies that attachments appear in <strong>both</strong> the native Hostinger Webmail attachment bar AND inline in the email body.</p>
          <div style="margin: 15px 0; text-align: center;">
            <a href="${testDirectUrl}" target="_blank" style="background-color: #9B1B30; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">
              🔍 View / Download Full Test Screenshot
            </a>
          </div>
          <div style="text-align: center; margin-top: 15px;">
            <img src="cid:support_attachment_preview" style="border: 2px solid #C9A84C; border-radius: 8px; max-width: 100%;" alt="Test Preview" />
          </div>
        </div>
      `,
    });

    return reply.send({
      success: true,
      messageId: info.messageId,
      message: 'Test email with attachment sent successfully to ' + smtpUser,
    });
  } catch (err) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 8. POST /api/contact
// -------------------------------------------------------------
app.post('/api/contact', async (request, reply) => {
  try {
    const { name, email, topic, message, phone, attachment, attachmentName } = request.body || {};

    lastContactInquiry = {
      timestamp: new Date().toISOString(),
      name: name || null,
      email: email || null,
      topic: topic || null,
      phone: phone || null,
      messageLength: message ? message.length : 0,
      hasAttachment: !!attachment,
      attachmentType: typeof attachment,
      attachmentLength: attachment ? attachment.length : 0,
      attachmentName: attachmentName || null,
    };

    console.log(`[Contact Support] >>> Received inquiry from "${name}" <${email}> [Topic: ${topic}]`);
    console.log(`[Contact Support] Request body keys:`, Object.keys(request.body || {}));
    if (attachment) {
      console.log(`[Contact Support] Attachment received! Type: ${typeof attachment}, Length: ${attachment.length}, Name: ${attachmentName}`);
    } else {
      console.warn(`[Contact Support] NO attachment in request.body (value is: ${attachment})`);
    }

    if (!name || !email || !topic || !message) {
      return reply.status(400).send({ error: 'All fields are required. Please check your inputs and try again.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send({ error: 'Please enter a valid email address.' });
    }

    if (message.trim().length < 5) {
      return reply.status(400).send({ error: 'Message must be at least 5 characters long.' });
    }

    const smtpPass = process.env.EMAIL_PASS;
    if (!smtpPass) {
      console.warn('SMTP Password (EMAIL_PASS) is not configured in env. Skipping real email dispatch.');
      return reply.send({
        success: true,
        message: "Message received! Our support team will get back to you shortly.",
      });
    }

    const smtpHost = process.env.EMAIL_HOST || 'smtp.hostinger.com';
    const smtpPort = parseInt(process.env.EMAIL_PORT || '465');
    const smtpUser = process.env.EMAIL_USER || 'support@biodata99.com';

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      debug: false,
      logger: false,
      connectionTimeout: 30000,
      socketTimeout: 60000,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    // Parse attachment if provided
    const mailAttachments = [];
    let hasValidAttachment = false;
    let safeAttachmentName = 'screenshot.jpg';
    let attachmentContentType = 'image/jpeg';
    let fileSizeDisplay = '';
    let directAttachmentUrl = '';

    if (attachment && typeof attachment === 'string' && attachment.length > 20) {
      try {
        let contentType = 'image/jpeg';
        let base64Data = attachment;

        if (attachment.startsWith('data:')) {
          const commaIndex = attachment.indexOf(',');
          if (commaIndex !== -1) {
            const header = attachment.substring(0, commaIndex);
            const mimeMatch = header.match(/data:([^;]+)/);
            if (mimeMatch && mimeMatch[1]) {
              contentType = mimeMatch[1].trim();
            }
            base64Data = attachment.substring(commaIndex + 1);
          }
        }

        // Clean any whitespace/newlines from base64 string
        base64Data = base64Data.trim().replace(/\s+/g, '');
        let buffer = Buffer.from(base64Data, 'base64');

        if (buffer && buffer.length > 0) {
          // If large image (> 1.5MB), optimize on server with sharp
          if (contentType.startsWith('image/') && buffer.length > 1.5 * 1024 * 1024) {
            try {
              buffer = await sharp(buffer)
                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
              contentType = 'image/jpeg';
              console.log(`[Contact Support] Image optimized with Sharp to ${buffer.length} bytes`);
            } catch (sharpErr) {
              console.warn('[Contact Support] Sharp optimization skipped:', sharpErr.message);
            }
          }

          hasValidAttachment = true;
          attachmentContentType = contentType;

          const extMap = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'application/pdf': 'pdf',
          };
          const ext = extMap[contentType.toLowerCase()] || 'jpg';

          if (attachmentName && typeof attachmentName === 'string' && attachmentName.trim()) {
            safeAttachmentName = attachmentName.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!safeAttachmentName.includes('.')) {
              safeAttachmentName += `.${ext}`;
            }
          } else {
            safeAttachmentName = `support_attachment_${Date.now()}.${ext}`;
          }

          const fileSizeKb = Math.round(buffer.length / 1024);
          fileSizeDisplay = fileSizeKb > 1024 ? `${(fileSizeKb / 1024).toFixed(1)} MB` : `${fileSizeKb} KB`;

          // Generate direct high-speed URL
          const attachmentId = crypto.randomUUID();
          contactAttachments.set(attachmentId, {
            buffer,
            contentType,
            filename: safeAttachmentName,
            createdAt: Date.now(),
          });

          // Trim memory if more than 200 attachments
          if (contactAttachments.size > 200) {
            const oldestKey = contactAttachments.keys().next().value;
            if (oldestKey) contactAttachments.delete(oldestKey);
          }

          const hostUrl = process.env.APP_ENV === 'production'
            ? 'https://api.biodata99.com'
            : (request.headers.host ? `http://${request.headers.host}` : 'http://localhost:4000');
          directAttachmentUrl = `${hostUrl}/api/contact/attachment/${attachmentId}`;

          console.log(`[Contact Support] Attachment Buffer created! Size: ${buffer.length} bytes (${fileSizeDisplay}), Type: ${contentType}, Direct URL: ${directAttachmentUrl}`);

          // 1. Regular file attachment WITHOUT CID - forces Webmail (Roundcube / Hostinger)
          // to show the attachment in the top ATTACHMENTS BAR with download button!
          mailAttachments.push({
            filename: safeAttachmentName,
            content: buffer,
            contentType: contentType,
            contentDisposition: 'attachment',
          });

          // 2. Inline preview WITH CID - allows inline <img src="cid:support_attachment_preview" /> in email body
          if (contentType.startsWith('image/')) {
            mailAttachments.push({
              filename: `preview_${safeAttachmentName}`,
              content: buffer,
              contentType: contentType,
              contentDisposition: 'inline',
              cid: 'support_attachment_preview',
            });
          }
        }
      } catch (attErr) {
        console.error('[Contact Support] Attachment parsing failed:', attErr);
        app.log.warn('Could not parse attachment for contact inquiry:', attErr);
      }
    } else {
      console.warn(`[Contact Support] No valid attachment to process. attachment is: ${typeof attachment}, length: ${attachment ? attachment.length : 0}`);
    }

    const adminMailOptions = {
      from: `"biodata99.com Contact" <${smtpUser}>`,
      to: smtpUser,
      replyTo: email,
      subject: `[${topic}] New Contact Inquiry from ${name}${hasValidAttachment ? ' [Attachment Included]' : ''}`,
      attachments: mailAttachments,
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #fdf8f4; padding: 25px; border-radius: 12px; border: 1px solid #C9A84C; max-width: 620px; margin: 0 auto; color: #333333;">
          <h2 style="color: #9B1B30; border-bottom: 2px solid #C9A84C; padding-bottom: 10px; margin-top: 0; font-size: 20px;">New Support Inquiry</h2>
          <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
            <tr>
              <td style="padding: 6px 0; font-weight: bold; width: 120px; color: #666666;">Full Name:</td>
              <td style="padding: 6px 0; font-size: 15px; font-weight: bold; color: #222222;">${name}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Email:</td>
              <td style="padding: 6px 0; font-size: 15px;"><a href="mailto:${email}" style="color: #9B1B30; text-decoration: none; font-weight: bold;">${email}</a></td>
            </tr>
            ${phone ? `<tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Phone:</td>
              <td style="padding: 6px 0; font-size: 15px; font-weight: bold;">${phone}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Inquiry Topic:</td>
              <td style="padding: 6px 0; font-size: 15px; font-weight: bold; color: #C9A84C;">${topic}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Received At:</td>
              <td style="padding: 6px 0; font-size: 14px; color: #888888;">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</td>
            </tr>
            ${hasValidAttachment ? `<tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Attached Item:</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: bold; color: #9B1B30;">📎 ${safeAttachmentName} (${fileSizeDisplay})</td>
            </tr>` : ''}
          </table>

          <div style="margin-top: 20px;">
            <p style="margin: 0 0 8px 0; font-weight: bold; color: #666666; font-size: 13px;">User Message:</p>
            <div style="background-color: #ffffff; border: 1px solid #e5ded4; border-radius: 8px; padding: 18px; line-height: 1.6; white-space: pre-wrap; font-size: 14px; color: #333333;">
              ${message}
            </div>
          </div>

          ${hasValidAttachment ? `
            <div style="margin-top: 22px; padding: 18px; background-color: #ffffff; border: 2px solid #C9A84C; border-radius: 10px;">
              <div style="margin-bottom: 12px; border-bottom: 1px solid #f0e6d6; padding-bottom: 10px;">
                <p style="margin: 0; font-weight: bold; color: #9B1B30; font-size: 15px;">
                  📎 Attached Screenshot / File: <span style="color: #222222; font-weight: 600;">${safeAttachmentName}</span>
                </p>
                <p style="margin: 4px 0 0 0; font-size: 12px; color: #666666;">
                  Size: <strong>${fileSizeDisplay}</strong> &bull; Attached as email file & direct link
                </p>
              </div>

              ${directAttachmentUrl ? `
                <div style="margin: 16px 0; text-align: center;">
                  <a href="${directAttachmentUrl}" target="_blank" style="display: inline-block; background-color: #9B1B30; color: #ffffff; padding: 11px 22px; font-weight: bold; text-decoration: none; border-radius: 6px; font-size: 14px; box-shadow: 0 2px 4px rgba(155,27,48,0.25);">
                    🔍 View / Download Full Screenshot
                  </a>
                </div>
              ` : ''}

              ${attachmentContentType.startsWith('image/') ? `
                <div style="text-align: center; background-color: #faf8f5; padding: 12px; border-radius: 6px; border: 1px dashed #d8c29d; margin-top: 10px;">
                  <a href="${directAttachmentUrl || '#'}" target="_blank">
                    <img src="cid:support_attachment_preview" style="max-width: 100%; max-height: 520px; height: auto; border-radius: 6px; display: inline-block; box-shadow: 0 2px 6px rgba(0,0,0,0.06);" alt="Attached: ${safeAttachmentName}" />
                  </a>
                </div>
              ` : `
                <div style="padding: 16px; background-color: #faf8f5; border-radius: 6px; text-align: center; color: #555555; font-size: 14px;">
                  📄 <strong>${safeAttachmentName}</strong> (${fileSizeDisplay}) is attached to this email.
                </div>
              `}
              <p style="margin: 10px 0 0 0; font-size: 11px; color: #888888; text-align: center;">
                ✓ This item is attached to this email. You can also view or download it directly from your webmail attachments bar.
              </p>
            </div>
          ` : ''}

          <p style="font-size: 12px; color: #888888; text-align: center; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px;">
            This email was sent automatically from the contact form on biodata99.com.
          </p>
        </div>
      `,
    };

    const userMailOptions = {
      from: `"biodata99.com Support" <${smtpUser}>`,
      to: email,
      subject: `Inquiry Received: ${topic} - biodata99.com`,
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #fdf8f4; padding: 30px; border-radius: 12px; border: 1px solid #C9A84C; max-width: 600px; margin: 0 auto; color: #333333;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #9B1B30; margin: 0; font-size: 24px;">biodata99.com</h1>
            <p style="color: #C9A84C; margin: 2px 0 0 0; font-size: 13px; letter-spacing: 1px; font-weight: bold; text-transform: uppercase;">Marriage Biodata Maker</p>
          </div>
          <p style="font-size: 15px; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
          <p style="font-size: 15px; line-height: 1.6;">
            Thank you for reaching out to us! We have successfully received your inquiry regarding <strong>${topic}</strong>.
          </p>
          <p style="font-size: 15px; line-height: 1.6;">
            Our support team is currently reviewing your message, and we aim to get back to you with a comprehensive response within <strong>24 hours</strong> (excluding Sundays).
          </p>
          
          <div style="background-color: #ffffff; border-left: 4px solid #9B1B30; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #555555;">
            <h4 style="margin: 0 0 6px 0; color: #9B1B30; font-size: 13px; text-transform: uppercase; tracking-wider: 1px;">Your Message Copy:</h4>
            <div style="white-space: pre-wrap; line-height: 1.5;">${message}</div>
          </div>

          ${hasValidAttachment ? `
            <div style="background-color: #ffffff; border: 1px solid #e2d9cd; padding: 12px 15px; margin: 15px 0; border-radius: 6px; font-size: 13px; color: #555555;">
              📎 <strong>Attachment Received:</strong> ${safeAttachmentName} (${fileSizeDisplay})
            </div>
          ` : ''}

          <div style="background-color: #f9f6f0; border: 1px solid #e6dfd3; border-radius: 8px; padding: 15px; font-size: 13px; color: #776e5d; margin-top: 20px;">
            🛡️ <strong>Privacy Shield Reminder:</strong> Since we prioritize your privacy and **do not store any user details or biodatas on our servers**, we cannot retrieve or recover downloaded PDFs or editing details. Any future updates must be performed directly through the app on the same device.
          </div>

          <p style="font-size: 15px; line-height: 1.6; margin-top: 25px;">
            Warm regards,<br />
            <strong>biodata99.com Support Team</strong>
          </p>
          
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center; font-size: 12px; color: #888888;">
            <p style="margin: 0;">We typically reply within 24 hours during working days.</p>
          </div>
        </div>
      `,
    };

    try {
      const sendResult = await transporter.sendMail(adminMailOptions);
      console.log(`[Contact Support] Admin email sent successfully. ID: ${sendResult.messageId}, Attachments: ${mailAttachments.length}`);
    } catch (sendErr) {
      console.error('[Contact Support] Dispatch error with attachment:', sendErr);
      app.log.error('Contact Form SMTP Dispatch Error with attachment:', sendErr);
      if (mailAttachments.length > 0) {
        console.warn('[Contact Support] Retrying email dispatch without attachment...');
        const fallbackOptions = { ...adminMailOptions, attachments: [] };
        await transporter.sendMail(fallbackOptions);
      } else {
        throw sendErr;
      }
    }

    transporter.sendMail(userMailOptions).catch((uErr) => {
      app.log.warn('User confirmation email copy failed:', uErr.message);
    });

    return reply.send({
      success: true,
      message: "Your message has been delivered successfully! Our support team will get back to you shortly.",
    });
  } catch (error) {
    app.log.error('Contact Form SMTP Dispatch Error:', error);
    reply.status(500).send({ error: 'Failed to dispatch email inquiry. Please try again or email support@biodata99.com directly.' });
  }
});

}

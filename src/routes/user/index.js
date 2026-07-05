import { prisma } from '../../lib/prisma.js';
import nodemailer from 'nodemailer';
import { getCachedOrFetch } from '../../lib/redis.js';
import { mapDbTemplateToConfig } from '../../../helpers.js';

const SETTINGS_CACHE_KEY = "admin:review-settings";

const templateSelect = {
  id: true,
  name: true,
  description: true,
  defaultPrimary: true,
  defaultSecondary: true,
  defaultAccent: true,
  defaultPadding: true,
  defaultYPadding: true,
  defaultPaddingTop: true,
  defaultPaddingRight: true,
  defaultPaddingLeft: true,
  defaultFontSize: true,
  photoX: true,
  photoY: true,
  photoWidth: true,
  photoHeight: true,
  photoCornerRadius: true,
  photoShowBorder: true,
  frameType: true,
  frameUrlTemplate: true,
  frameBgType: true,
  frameBgColor: true,
  frameBgGradientColors: true,
  frameOuterInset: true,
  frameOuterStrokeWidth: true,
  frameOuterCornerRadius: true,
  frameInnerInset: true,
  frameInnerStrokeWidth: true,
  frameInnerCornerRadius: true,
  frameHasCornerCurves: true,
  frameGradientColors: true,
  frameComponentId: true,
  thumbnailUrl: true,
  previewPhotoUrl: true,
  rawInput: true,
  bgConfig: true,
  detailsLayout: true,
  titleShape: true,
  defaultHeadingAlign: true,
  sectionHeadingShape: true,
  mantraSignPlacement: true,
  mantraSignVertical: true,
  language: true,
  religion: true,
  gender: true,
  active: true,
  isPremium: true,
  isDefault: true,
  price: true,
  discountPrice: true,
  currency: true,
  pdfPrice: true,
  pdfDiscountPrice: true,
  docxPrice: true,
  docxDiscountPrice: true,
  jpgPrice: true,
  jpgDiscountPrice: true,
  pngPrice: true,
  pngDiscountPrice: true,
  comboPrice: true,
  comboDiscountPrice: true,
  createdAt: true,
  updatedAt: true
};

export default async function routes(app, options) {
app.get('/api/bootstrap', async (request, reply) => {
  try {
    const data = await getCachedOrFetch('templates:bootstrap', 300, async () => {
      const [dbTemplates, dbStickers, dbBackgrounds, dbReviewSettings] = await Promise.all([
        prisma.template.findMany({
          where: { active: true, isDefault: true },
          select: templateSelect,
          orderBy: { createdAt: 'desc' },
          take: 100
        }),
        prisma.sticker.findMany({
          where: { type: 'Mantra' },
          orderBy: { createdAt: 'desc' },
          take: 100
        }),
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
        templates: dbTemplates.map(mapDbTemplateToConfig),
        stickers: dbStickers,
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
      const { name, location, format, templateId, orderId, status, errorMsg } = request.body;

      if (!name || !format) {
        reply.status(400).send({ error: 'Name and format are required fields' });
        return;
      }

      // Resolve orderId if null or missing
      let resolvedOrderId = orderId;
      if (!resolvedOrderId && name && templateId) {
        try {
          let matchingOrder = await prisma.order.findFirst({
            where: {
              customerName: name,
              templateId: templateId,
              status: 'paid',
            },
            orderBy: {
              createdAt: 'desc',
            },
          });
          if (!matchingOrder) {
            matchingOrder = await prisma.order.findFirst({
              where: {
                customerName: name,
                templateId: templateId,
              },
              orderBy: {
                createdAt: 'desc',
              },
            });
          }
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
      const userAgent = request.headers['user-agent'];

      const isDev = process.env.NEXT_PUBLIC_IS_DEV === 'true';
      let log = null;

      if (isDev) {
        console.log('Dev mode active: skipping download logs insertion to DB.');
        log = {
          id: 'dev-mock-log-id',
          name,
          location: location || null,
          format,
          templateId: templateId || null,
          ipAddress,
          userAgent,
          createdAt: new Date(),
        };
      } else {
        log = await prisma.downloadLog.create({
          data: {
            name,
            location: location || null,
            format,
            templateId: templateId || null,
            ipAddress,
            userAgent,
            orderId: resolvedOrderId || null,
            errorMsg: errorMsg || null,
          },
        });
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
// 8. POST /api/contact
// -------------------------------------------------------------
app.post('/api/contact', async (request, reply) => {
  try {
    const { name, email, topic, message } = request.body;

    if (!name || !email || !topic || !message) {
      reply.status(400).send({ error: 'All fields are required. Please check your inputs and try again.' });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.status(400).send({ error: 'Please enter a valid email address.' });
      return;
    }

    if (message.trim().length < 10) {
      reply.status(400).send({ error: 'Message must be at least 10 characters long.' });
      return;
    }

    const smtpPass = process.env.EMAIL_PASS;
    if (!smtpPass) {
      console.warn('SMTP Password (EMAIL_PASS) is not configured in env. Skipping real email dispatch.');
      return {
        success: true,
        message: "Message received locally! (SMTP credentials not configured in env, email skipped)",
      };
    }

    const smtpHost = process.env.EMAIL_HOST || 'smtp.hostinger.com';
    const smtpPort = parseInt(process.env.EMAIL_PORT || '465');
    const smtpUser = process.env.EMAIL_USER || 'support@biodata99.com';

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      debug: true,
      logger: true,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const adminMailOptions = {
      from: `"biodata99.com Contact" <${smtpUser}>`,
      to: smtpUser,
      subject: `[${topic}] New Contact Inquiry from ${name}`,
      html: `
        <div style="font-family: 'Inter', sans-serif; background-color: #fdf8f4; padding: 30px; border-radius: 12px; border: 1px solid #C9A84C; max-width: 600px; margin: 0 auto; color: #333333;">
          <h2 style="color: #9B1B30; border-bottom: 2px solid #C9A84C; padding-bottom: 10px; margin-top: 0;">New Support Inquiry</h2>
          <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
            <tr>
              <td style="padding: 6px 0; font-weight: bold; width: 120px; color: #666666;">Full Name:</td>
              <td style="padding: 6px 0; font-size: 15px; font-weight: bold;">${name}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Email:</td>
              <td style="padding: 6px 0; font-size: 15px;"><a href="mailto:${email}" style="color: #9B1B30; text-decoration: none; font-weight: bold;">${email}</a></td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Inquiry Topic:</td>
              <td style="padding: 6px 0; font-size: 15px; font-weight: bold; color: #C9A84C;">${topic}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-weight: bold; color: #666666;">Received At:</td>
              <td style="padding: 6px 0; font-size: 14px; color: #888888;">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</td>
            </tr>
          </table>
          <div style="background-color: #ffffff; border: 1px solid #eee; border-radius: 8px; padding: 20px; margin-top: 20px; line-height: 1.6; white-space: pre-wrap; font-size: 14px; color: #444444;">
            ${message}
          </div>
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
        <div style="font-family: 'Inter', sans-serif; background-color: #fdf8f4; padding: 30px; border-radius: 12px; border: 1px solid #C9A84C; max-width: 600px; margin: 0 auto; color: #333333;">
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

          <div style="background-color: #f9f6f0; border: 1px solid #e6dfd3; border-radius: 8px; padding: 15px; font-size: 13px; color: #776e5d; margin-top: 20px;">
            🛡️ <strong>Privacy Shield Reminder:</strong> Since we prioritize your privacy and **do not store any user details or biodatas on our servers**, we cannot retrieve or recover downloaded PDFs or editing details. Any future updates must be performed directly through the app on the same device.
          </div>

          <p style="font-size: 15px; line-height: 1.6; margin-top: 25px;">
            Warm regards,<br />
            <strong>biodata99.com Support Team</strong>
          </p>
          
          <div style="border-top: 1px solid #eee; margin-top: 30px; padding-top: 15px; text-align: center; font-size: 12px; color: #888888;">
            <p style="margin: 0 0 5px 0;">Have an urgent question? You can also message us directly on WhatsApp!</p>
            <a href="https://wa.me/8208892771" style="color: #25d366; font-weight: bold; text-decoration: none;">Chat with Support on WhatsApp</a>
          </div>
        </div>
      `,
    };

    await Promise.all([
      transporter.sendMail(adminMailOptions),
      transporter.sendMail(userMailOptions),
    ]);

    return {
      success: true,
      message: "Your message has been delivered successfully! We've sent a confirmation email to you.",
    };
  } catch (error) {
    app.log.error('Contact Form SMTP Dispatch Error:', error);
    reply.status(500).send({ error: 'Failed to dispatch email inquiry. Please try again or email support@biodata99.com directly.' });
  }
});

}

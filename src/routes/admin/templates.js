import { prisma } from '../../lib/prisma.js';
import { getCachedOrFetch, redis } from '../../lib/redis.js';
import { uploadToVPS, deleteFromVPS } from '../../lib/vps-upload.js';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';

function safeParseInt(val, defaultVal = null) {
  if (val === undefined || val === null || val === "") return defaultVal;
  const parsed = parseInt(val);
  return isNaN(parsed) ? defaultVal : parsed;
}

function safeParseFloat(val, defaultVal = null) {
  if (val === undefined || val === null || val === "") return defaultVal;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultVal : parsed;
}

export default async function adminTemplateRoutes(fastify, options) {

  async function clearTemplateCaches() {
    if (redis && redis.status === 'ready') {
      try {
        const keys = await redis.keys('templates:*');
        if (keys && keys.length > 0) {
          await redis.del(keys);
        }
        await redis.del('admin:templates');
      } catch (err) {
        fastify.log.error('Clear template caches error:', err);
      }
    }
  }

  // GET all templates
  fastify.get('/templates', async (request, reply) => {
    try {
      const templates = await getCachedOrFetch('admin:templates', 3600, () =>
        prisma.template.findMany({
          select: {
            id: true,
            name: true,
            description: true,
            defaultPrimary: true,
            defaultSecondary: true,
            defaultAccent: true,
            defaultPadding: true,
            frameType: true,
            frameUrlTemplate: true,
            thumbnailUrl: true,
            previewPhotoUrl: true,
            detailsLayout: true,
            titleShape: true,
            language: true,
            religion: true,
            gender: true,
            active: true,
            isPremium: true,
            isDefault: true,
            price: true,
            discountPrice: true,
            currency: true,
            createdAt: true,
            updatedAt: true
          },
          orderBy: { createdAt: 'desc' }
        })
      );
      return { templates };
    } catch (error) {
      request.log.error('List admin templates error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET single template by ID
  fastify.get('/templates/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const template = await prisma.template.findUnique({
        where: { id }
      });
      if (!template) {
        return reply.status(404).send({ error: 'Template not found' });
      }
      return { success: true, template };
    } catch (error) {
      request.log.error('Get single template error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST create a template
  fastify.post('/templates', async (request, reply) => {
    try {
      const body = request.body;
      const {
        name, description, defaultPrimary, defaultSecondary, defaultAccent,
        defaultPadding, defaultYPadding, defaultPaddingTop, defaultPaddingRight,
        defaultPaddingLeft, defaultFontSize, photoX, photoY, photoWidth, photoHeight,
        photoCornerRadius, frameType, frameBgColor, frameOuterInset,
        frameOuterStrokeWidth, frameOuterCornerRadius, frameInnerInset,
        frameInnerStrokeWidth, frameInnerCornerRadius, frameHasCornerCurves,
        frameGradientColors, frameBgType, frameBgGradientColors, frameComponentId,
        frameFile, thumbnailFile, bgConfig, language, detailsLayout, titleShape,
        mantraSignPlacement, mantraSignVertical, photoShowBorder, isPremium, price,
        discountPrice, currency, pdfPrice, pdfDiscountPrice, docxPrice, docxDiscountPrice, jpgPrice, jpgDiscountPrice,
        pngPrice, pngDiscountPrice, comboPrice, comboDiscountPrice, previewPhotoFile,
        rawInput, religion, isDefault, gender, frameUrlTemplate, thumbnailUrl
      } = body;

      if (!name || !defaultPrimary || !defaultSecondary || !defaultAccent || !frameType) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      if (isDefault === true) {
        await prisma.template.updateMany({ data: { isDefault: false } });
      }

      let finalFrameUrl = frameUrlTemplate || '';
      if (frameFile) {
        finalFrameUrl = await uploadToVPS(frameFile, 'frames');
      }

      let finalThumbnailUrl = thumbnailUrl || '';
      if (thumbnailFile) {
        finalThumbnailUrl = await uploadToVPS(thumbnailUrl, 'thumbnails');
      }

      let finalPreviewUrl = null;
      if (previewPhotoFile) {
        finalPreviewUrl = await uploadToVPS(previewPhotoFile, 'previews');
      }

      const template = await prisma.template.create({
        data: {
          name, description: description || '',
          defaultPrimary, defaultSecondary, defaultAccent,
          defaultPadding: parseInt(defaultPadding) || 60,
          defaultYPadding: parseInt(defaultYPadding) || null,
          defaultPaddingTop: parseInt(defaultPaddingTop) || null,
          defaultPaddingRight: parseInt(defaultPaddingRight) || null,
          defaultPaddingLeft: parseInt(defaultPaddingLeft) || null,
          defaultFontSize: parseInt(defaultFontSize) || null,
          photoX: parseInt(photoX) || 390,
          photoY: parseInt(photoY) || 100,
          photoWidth: parseInt(photoWidth) || 100,
          photoHeight: parseInt(photoHeight) || 130,
          photoCornerRadius: parseInt(photoCornerRadius) || 8,
          frameType,
          frameBgType: frameBgType || 'solid',
          frameBgColor: frameBgColor || '#ffffff',
          frameBgGradientColors: frameBgGradientColors || [],
          frameUrlTemplate: finalFrameUrl,
          frameOuterInset: parseInt(frameOuterInset) || null,
          frameOuterStrokeWidth: parseInt(frameOuterStrokeWidth) || null,
          frameOuterCornerRadius: parseInt(frameOuterCornerRadius) || null,
          frameInnerInset: parseInt(frameInnerInset) || null,
          frameInnerStrokeWidth: parseInt(frameInnerStrokeWidth) || null,
          frameInnerCornerRadius: parseInt(frameInnerCornerRadius) || null,
          frameHasCornerCurves: frameHasCornerCurves === true,
          frameGradientColors: frameGradientColors || [],
          frameComponentId: frameComponentId || null,
          thumbnailUrl: finalThumbnailUrl,
          previewPhotoUrl: finalPreviewUrl,
          rawInput: rawInput || undefined,
          religion: religion || 'General',
          gender: gender || 'both',
          bgConfig: bgConfig || undefined,
          language: language || 'English',
          detailsLayout: detailsLayout || 'classic',
          titleShape: titleShape || 'simple',
          mantraSignPlacement: mantraSignPlacement || 'both',
          mantraSignVertical: mantraSignVertical || 'top',
          photoShowBorder: photoShowBorder !== false,
          active: true,
          isDefault: isDefault === true,
          isPremium: isPremium === true,
          price: parseFloat(price) || null,
          discountPrice: parseFloat(discountPrice) || null,
          currency: currency || 'INR',
          pdfPrice: parseFloat(pdfPrice) || null,
          pdfDiscountPrice: parseFloat(pdfDiscountPrice) || null,
          docxPrice: parseFloat(docxPrice) || null,
          docxDiscountPrice: parseFloat(docxDiscountPrice) || null,
          jpgPrice: parseFloat(jpgPrice) || null,
          jpgDiscountPrice: parseFloat(jpgDiscountPrice) || null,
          pngPrice: parseFloat(pngPrice) || null,
          pngDiscountPrice: parseFloat(pngDiscountPrice) || null,
          comboPrice: parseFloat(comboPrice) || null,
          comboDiscountPrice: parseFloat(comboDiscountPrice) || null,
        },
      });

      await clearTemplateCaches();

      return { success: true, template };
    } catch (error) {
      fastify.log.error('Create template error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  // PATCH/PUT update template by ID
  const updateHandler = async (request, reply) => {
    try {
      const { id } = request.params;
      const body = request.body;

      const existing = await prisma.template.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      const updateData = {};
      const fields = [
        "name", "description", "defaultPrimary", "defaultSecondary", "defaultAccent",
        "frameType", "frameBgType", "frameBgColor", "frameComponentId", "language",
        "active", "detailsLayout", "titleShape", "mantraSignPlacement", "mantraSignVertical",
        "religion", "gender", "rawInput"
      ];

      fields.forEach((field) => {
        if (body[field] !== undefined) {
          updateData[field] = body[field];
        }
      });

      const numericFields = [
        "defaultPadding", "defaultYPadding", "defaultPaddingTop", "defaultPaddingRight",
        "defaultPaddingLeft", "defaultFontSize", "photoX", "photoY", "photoWidth",
        "photoHeight", "photoCornerRadius", "frameOuterInset", "frameOuterStrokeWidth",
        "frameOuterCornerRadius", "frameInnerInset", "frameInnerStrokeWidth",
        "frameInnerCornerRadius"
      ];

      numericFields.forEach((field) => {
        if (body[field] !== undefined) {
          updateData[field] = safeParseInt(body[field]);
        }
      });

      if (body.frameHasCornerCurves !== undefined) {
        updateData.frameHasCornerCurves = body.frameHasCornerCurves === true;
      }
      if (body.photoShowBorder !== undefined) {
        updateData.photoShowBorder = body.photoShowBorder === true;
      }
      if (body.frameGradientColors !== undefined) {
        updateData.frameGradientColors = body.frameGradientColors;
      }
      if (body.frameBgGradientColors !== undefined) {
        updateData.frameBgGradientColors = body.frameBgGradientColors;
      }

      // Pricing
      if (body.isPremium !== undefined) updateData.isPremium = body.isPremium === true;
      if (body.isDefault !== undefined) updateData.isDefault = body.isDefault === true;
      if (body.price !== undefined) updateData.price = safeParseFloat(body.price);
      if (body.discountPrice !== undefined) updateData.discountPrice = safeParseFloat(body.discountPrice);
      if (body.currency !== undefined) updateData.currency = body.currency || "INR";
      if (body.pdfPrice !== undefined) updateData.pdfPrice = safeParseFloat(body.pdfPrice);
      if (body.pdfDiscountPrice !== undefined) updateData.pdfDiscountPrice = safeParseFloat(body.pdfDiscountPrice);
      if (body.docxPrice !== undefined) updateData.docxPrice = safeParseFloat(body.docxPrice);
      if (body.docxDiscountPrice !== undefined) updateData.docxDiscountPrice = safeParseFloat(body.docxDiscountPrice);
      if (body.jpgPrice !== undefined) updateData.jpgPrice = safeParseFloat(body.jpgPrice);
      if (body.jpgDiscountPrice !== undefined) updateData.jpgDiscountPrice = safeParseFloat(body.jpgDiscountPrice);
      if (body.pngPrice !== undefined) updateData.pngPrice = safeParseFloat(body.pngPrice);
      if (body.pngDiscountPrice !== undefined) updateData.pngDiscountPrice = safeParseFloat(body.pngDiscountPrice);
      if (body.comboPrice !== undefined) updateData.comboPrice = safeParseFloat(body.comboPrice);
      if (body.comboDiscountPrice !== undefined) updateData.comboDiscountPrice = safeParseFloat(body.comboDiscountPrice);

      // File re-uploads
      if (body.frameFile) {
        if (existing.frameUrlTemplate) {
          await deleteFromVPS(existing.frameUrlTemplate);
        }
        updateData.frameUrlTemplate = await uploadToVPS(body.frameFile, 'frames');
      } else if (body.frameUrlTemplate !== undefined) {
        updateData.frameUrlTemplate = body.frameUrlTemplate;
      }

      if (body.thumbnailFile) {
        if (existing.thumbnailUrl) {
          await deleteFromVPS(existing.thumbnailUrl);
        }
        updateData.thumbnailUrl = await uploadToVPS(body.thumbnailFile, 'thumbnails');
      } else if (body.thumbnailUrl !== undefined) {
        updateData.thumbnailUrl = body.thumbnailUrl;
      }

      if (body.previewPhotoFile) {
        if (existing.previewPhotoUrl) {
          await deleteFromVPS(existing.previewPhotoUrl);
        }
        updateData.previewPhotoUrl = await uploadToVPS(body.previewPhotoFile, 'previews');
      } else if (body.previewPhotoUrl !== undefined) {
        updateData.previewPhotoUrl = body.previewPhotoUrl;
      }

      // Background configurations
      if (body.bgConfig !== undefined) {
        if (body.bgConfig === null) {
          updateData.bgConfig = null;
        } else {
          const bgConfigData = { ...body.bgConfig };
          if (bgConfigData.file) {
            if (existing.bgConfig) {
              try {
                const prevConfig = typeof existing.bgConfig === "string" ? JSON.parse(existing.bgConfig) : existing.bgConfig;
                if (prevConfig?.url) {
                  await deleteFromVPS(prevConfig.url);
                }
              } catch (e) {
                fastify.log.error("Error deleting old bgConfig image:", e);
              }
            }
            bgConfigData.url = await uploadToVPS(bgConfigData.file, 'backgrounds');
            delete bgConfigData.file;
          }
          updateData.bgConfig = bgConfigData;
        }
      }

      if (updateData.isDefault === true) {
        await prisma.template.updateMany({ data: { isDefault: false } });
      }

      const updated = await prisma.template.update({
        where: { id },
        data: updateData
      });

      await clearTemplateCaches();

      return { success: true, template: updated };
    } catch (error) {
      fastify.log.error('Update template error:', error);
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  };

  fastify.put('/templates/:id', updateHandler);
  fastify.patch('/templates/:id', updateHandler);

  // DELETE template
  fastify.delete('/templates/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const existing = await prisma.template.findUnique({
        where: { id }
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      // Clean up assets
      if (existing.frameUrlTemplate) await deleteFromVPS(existing.frameUrlTemplate);
      if (existing.thumbnailUrl) await deleteFromVPS(existing.thumbnailUrl);
      if (existing.previewPhotoUrl) await deleteFromVPS(existing.previewPhotoUrl);
      if (existing.bgConfig) {
        try {
          const prevConfig = typeof existing.bgConfig === "string" ? JSON.parse(existing.bgConfig) : existing.bgConfig;
          if (prevConfig?.url) await deleteFromVPS(prevConfig.url);
        } catch (e) {
          fastify.log.error("Error deleting bgConfig image on template delete:", e);
        }
      }

      await prisma.template.delete({
        where: { id }
      });

      await clearTemplateCaches();

      return { success: true, message: 'Template deleted successfully' };
    } catch (error) {
      fastify.log.error('Delete template error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST generate template name or description via AI (streaming)
  fastify.post('/templates/generate-ai', async (request, reply) => {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply.status(500).send({ error: 'GOOGLE_GENERATIVE_AI_API_KEY not configured' });
    }

    const {
      type, name,
      frameType, frameBgType, frameBgColor, frameBgGradientColors,
      defaultPrimary, defaultSecondary, defaultAccent,
      frameOuterInset, frameOuterStrokeWidth, frameOuterCornerRadius,
      frameInnerInset, frameInnerStrokeWidth, frameInnerCornerRadius,
      frameHasCornerCurves, frameGradientColors, frameComponentId,
    } = request.body || {};

    if (type !== 'name' && type !== 'description') {
      return reply.status(400).send({ error: 'type must be "name" or "description"' });
    }

    // Build a rich context string from the frame/color details
    const colorCtx = [
      defaultPrimary && `primary color ${defaultPrimary}`,
      defaultSecondary && `secondary color ${defaultSecondary}`,
      defaultAccent && `accent color ${defaultAccent}`,
    ].filter(Boolean).join(', ');

    const frameCtx = [
      frameType && `frame style: ${frameType}`,
      frameBgType && `background type: ${frameBgType}`,
      frameBgColor && frameBgType === 'solid' && `background color: ${frameBgColor}`,
      frameComponentId && `frame component: ${frameComponentId}`,
    ].filter(Boolean).join('; ');

    let prompt;
    if (type === 'name') {
      prompt = `You are a creative naming assistant for Indian matrimonial biodata templates.
Generate a SINGLE short, elegant template name (3–6 words) that reflects the visual style described below.
The name should feel premium, Indian-cultural, and suitable for a matrimonial biodata cover.
Do NOT include words like "template", "design", or "biodata". Return ONLY the name, nothing else.

Visual context: ${colorCtx}${frameCtx ? '; ' + frameCtx : ''}.`;
    } else {
      prompt = `You are a creative copywriter for an Indian matrimonial biodata maker app.
Write a SHORT marketing description (1–2 sentences, max 25 words) for a template named "${name || 'this template'}".
Highlight its elegance, cultural richness, and suitability for Indian weddings.
Return ONLY the description text, nothing else.

Visual context: ${colorCtx}${frameCtx ? '; ' + frameCtx : ''}.`;
    }

    try {
      const googleProvider = createGoogleGenerativeAI({ apiKey });
      const { text } = await generateText({
        model: googleProvider('gemini-2.5-flash'),
        prompt,
        maxTokens: 120,
      });

      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .send(text.trim());
    } catch (err) {
      fastify.log.error('generate-ai error:', err);
      // Extract the first bullet-point line from quota errors for a cleaner message
      let msg = err.message || 'AI generation failed';
      const quotaMatch = msg.match(/You exceeded your current quota[^\.]*\./);
      if (quotaMatch) msg = 'Gemini API quota exceeded. Please check your billing or try again later.';
      return reply.status(500).send({ error: msg });
    }
  });
}

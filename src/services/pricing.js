import { prisma, withRetry } from '../lib/prisma.js';

/**
 * Server-side price of a download.
 *
 * The browser sends an `amount` with create-order, but a browser can send anything. This module derives the
 * price from the Template row in the database so create-order can compare it with what the client sent.
 *
 * The formula mirrors the client's `getPriceForFormat` (BuilderContext.tsx) exactly, so a normal visitor's
 * price matches what the price dialog showed.
 */

const DEFAULT_PRICE = 49;
const DEFAULT_COMBO_PRICE = 79;
const CACHE_TTL_MS = 60_000;

const cache = new Map(); // templateId -> { at, tpl | null }

export function priceForFormat(format, tpl) {
  const discount = tpl.discountPrice;
  switch (String(format).toLowerCase()) {
    case 'pdf':
      return tpl.pdfDiscountPrice || discount || DEFAULT_PRICE;
    case 'docx':
      return tpl.docxDiscountPrice || discount || DEFAULT_PRICE;
    case 'jpg':
      return tpl.jpgDiscountPrice || discount || DEFAULT_PRICE;
    case 'png':
      return tpl.pngDiscountPrice || discount || DEFAULT_PRICE;
    case 'combo':
      return tpl.comboDiscountPrice || DEFAULT_COMBO_PRICE;
    default:
      return DEFAULT_PRICE;
  }
}

async function loadTemplate(templateId) {
  const hit = cache.get(templateId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tpl;

  const tpl = await withRetry(() =>
    prisma.template.findUnique({
      where: { id: String(templateId) },
      select: {
        discountPrice: true,
        pdfDiscountPrice: true,
        docxDiscountPrice: true,
        jpgDiscountPrice: true,
        pngDiscountPrice: true,
        comboDiscountPrice: true,
      },
    })
  );
  cache.set(templateId, { at: Date.now(), tpl: tpl || null });
  return tpl || null;
}

/**
 * Compare the amount the client sent with the database price.
 *
 * Returns { status, expected? } where status is one of:
 *   'match'    - within ₹0.50 of the database price
 *   'under'    - client amount is LOWER than the database price (the risky direction)
 *   'over'     - client amount is higher than the database price
 *   'unknown'  - template not in the database (static-only template) or the lookup failed
 */
export async function checkClientPrice(templateId, format, requestedAmount) {
  let tpl;
  try {
    tpl = await loadTemplate(templateId);
  } catch {
    return { status: 'unknown', reason: 'lookup_failed' };
  }
  if (!tpl) return { status: 'unknown', reason: 'template_not_in_db' };

  const expected = priceForFormat(format, tpl);
  if (Math.abs(requestedAmount - expected) <= 0.5) return { status: 'match', expected };
  return { status: requestedAmount < expected ? 'under' : 'over', expected };
}

/**
 * PRICE_VALIDATION controls what create-order does with a mismatch:
 *   shadow  (default) - log it, accept the order. No behaviour change; use this to watch real traffic first.
 *   enforce           - reject a mismatch with 409 PRICE_CHANGED so the client reloads and shows the real price.
 *   off               - skip the check entirely.
 */
export function priceValidationMode() {
  const raw = String(process.env.PRICE_VALIDATION || 'shadow').toLowerCase().trim();
  return ['shadow', 'enforce', 'off'].includes(raw) ? raw : 'shadow';
}

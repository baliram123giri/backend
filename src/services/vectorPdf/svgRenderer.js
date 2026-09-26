import { openSync } from 'fontkit';
import { resolveFontFilePath, detectScriptFontFamily, doesFontSupportScript } from './fontRegistry.js';
import { DESIGN_A4_WIDTH, DESIGN_A4_HEIGHT, PDF_A4_WIDTH_PT, PDF_A4_HEIGHT_PT } from './coordinates.js';

// Cache parsed fontkit fonts to avoid disk I/O on every export
const fontkitCache = new Map();

function getLoadedFont(fontPath) {
  if (fontkitCache.has(fontPath)) {
    return fontkitCache.get(fontPath);
  }
  if (typeof openSync !== 'function') {
    throw new Error('[SvgRenderer] fontkit.openSync function not found');
  }
  const font = openSync(fontPath);
  fontkitCache.set(fontPath, font);
  return font;
}

/**
 * Escapes special XML characters for safe SVG inclusion.
 * @param {string} str
 * @returns {string}
 */
export function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converts degrees to SVG linearGradient coordinate vectors.
 * Follows standard CSS linear-gradient angle conventions:
 * 0deg = to top (bottom to top)
 * 90deg = to right (left to right)
 * 180deg = to bottom (top to bottom)
 * 270deg = to left (right to left)
 * 
 * @param {number} angleDeg
 * @returns {{ x1: string, y1: string, x2: string, y2: string }}
 */
export function angleToGradientCoords(angleDeg = 0) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const x1 = Math.round(50 - Math.cos(rad) * 50);
  const y1 = Math.round(50 - Math.sin(rad) * 50);
  const x2 = Math.round(50 + Math.cos(rad) * 50);
  const y2 = Math.round(50 + Math.sin(rad) * 50);
  return {
    x1: `${x1}%`,
    y1: `${y1}%`,
    x2: `${x2}%`,
    y2: `${y2}%`,
  };
}

/**
 * Splits text into runs of Indic vs Latin/ASCII/Punctuation for multi-script shaping.
 */
export function splitRuns(lineStr) {
  const runs = [];
  const regex = /([\u0900-\u0D7F]+|[^\u0900-\u0D7F]+)/g;
  let match;
  while ((match = regex.exec(lineStr)) !== null) {
    const chunk = match[1];
    const isIndic = /[\u0900-\u0D7F]/.test(chunk);
    runs.push({ text: chunk, isIndic });
  }
  return runs.length > 0 ? runs : [{ text: lineStr, isIndic: false }];
}

/**
 * Converts text into vector SVG <path> elements with precise OpenType glyph shaping and positioning.
 * Each glyph is rendered as an outline with Y-axis inverted for SVG canvas.
 * This allows true vector <linearGradient> fills without Chrome PDFium tofu boxes.
 * 
 * @param {string} text
 * @param {string} fontPath
 * @param {number} fontSize
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {string} align 'left' | 'center' | 'right'
 * @returns {string|null} SVG XML string of <path> elements or null if unparseable
 */
export function textToVectorGlyphPaths(text, fontPath, fontSize, x, y, width = 525, align = 'left', lineHeight = null, latinFontPath = null) {
  try {
    const primaryFont = getLoadedFont(fontPath);
    const latinFont = latinFontPath ? getLoadedFont(latinFontPath) : primaryFont;
    const ascent = primaryFont.ascent || Math.round((primaryFont.unitsPerEm || 1000) * 0.8);
    const primaryScale = fontSize / (primaryFont.unitsPerEm || 1000);
    const effLineHeight = lineHeight || fontSize * 1.35;

    const lines = String(text || '').split('\n');
    const allPaths = [];
    let minX = Infinity;
    let maxX = -Infinity;
    const firstBaselineY = y + ascent * primaryScale;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineText = lines[lineIdx];
      if (!lineText) continue;

      const runs = splitRuns(lineText);

      // Pre-calculate line total advance width across runs for exact alignment
      let totalAdvance = 0;
      const plannedRuns = [];
      for (const r of runs) {
        const activeFont = r.isIndic ? primaryFont : latinFont;
        const activeScale = fontSize / (activeFont.unitsPerEm || 1000);
        const layoutRun = activeFont.layout(r.text);
        let runAdvance = 0;
        for (let i = 0; i < layoutRun.positions.length; i++) {
          runAdvance += layoutRun.positions[i].xAdvance * activeScale;
        }
        totalAdvance += runAdvance;
        plannedRuns.push({ run: r, font: activeFont, scale: activeScale, layout: layoutRun });
      }

      let startX = x;
      if (align === 'center') {
        startX = x + (width - totalAdvance) / 2;
      } else if (align === 'right') {
        startX = x + width - totalAdvance;
      }

      minX = Math.min(minX, startX);
      maxX = Math.max(maxX, startX + totalAdvance);

      // Baseline Y in SVG canvas (measured from top y + line offset)
      const baselineY = y + (lineIdx * effLineHeight) + ascent * primaryScale;
      let curX = startX;

      for (const plan of plannedRuns) {
        const { scale, layout } = plan;
        for (let i = 0; i < layout.glyphs.length; i++) {
          const glyph = layout.glyphs[i];
          const pos = layout.positions[i];

          // Skip .notdef (glyph.id === 0) so tofu boxes are never emitted
          if (glyph.id !== 0) {
            const gx = Number((curX + pos.xOffset * scale).toFixed(2));
            const gy = Number((baselineY + pos.yOffset * scale).toFixed(2));

            const d = glyph.path.toSVG();
            if (d) {
              allPaths.push(`<path d="${d}" transform="translate(${gx} ${gy}) scale(${scale} ${-scale})" />`);
            }
          }
          curX += pos.xAdvance * scale;
        }
      }
    }

    if (allPaths.length === 0) return null;
    return {
      svgPaths: allPaths.join('\n    '),
      startX: minX === Infinity ? x : minX,
      endX: maxX === -Infinity ? (x + width) : maxX,
      baselineY: firstBaselineY,
      fontSize,
    };
  } catch (err) {
    console.warn(`[SvgRenderer] textToVectorGlyphPaths failed: ${err.message}`);
    return null;
  }
}

/**
 * Pure Server-Side SVG Renderer for a Design Document Page.
 * Produces clean, vector SVG without any CSS hacks or container queries.
 * 
 * @param {object} page DesignPage object from DesignDocument
 * @param {object} options
 * @returns {string} Standalone SVG XML string
 */
export function renderDesignPageToSvg(page, options = {}) {
  const width = page.width || DESIGN_A4_WIDTH;
  const height = page.height || DESIGN_A4_HEIGHT;
  const elements = [...(page.elements || [])];

  // Pre-process section pill and section title elements for pixel-perfect width parity with preview
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el && el.id && String(el.id).startsWith('sec-pill-')) {
      const secKey = String(el.id).replace('sec-pill-', '');
      const titleEl = elements.find((t) => t && t.id === `sec-title-${secKey}`);
      if (titleEl && titleEl.text) {
        let titleFontFamily = titleEl.fontFamily || 'Noto Sans Devanagari';
        const hasIndic = /[\u0600-\u06FF\u0900-\u0D7F]/.test(titleEl.text);
        const normTitleFont = (titleFontFamily || '').toLowerCase().trim();
        const isLatinOnly = [
          'great vibes', 'alex brush', 'cinzel', 'cinzel decorative', 'playfair display',
          'cormorant garamond', 'eb garamond', 'lora', 'prata', 'marcellus', 'philosopher',
          'poppins', 'inter', 'montserrat', 'raleway', 'sacramento'
        ].includes(normTitleFont);
        if (hasIndic && (isLatinOnly || !titleFontFamily)) {
          titleFontFamily = detectScriptFontFamily(titleEl.text, 'Noto Sans Devanagari', true);
        }
        let fontPath = null;
        try {
          fontPath = resolveFontFilePath(titleFontFamily, titleEl.fontWeight || 800);
        } catch {}
        let latinFontPath = null;
        try {
          latinFontPath = resolveFontFilePath('Poppins', titleEl.fontWeight || 800);
        } catch {}

        if (fontPath) {
          try {
            const primaryFont = getLoadedFont(fontPath);
            const latinFont = latinFontPath ? getLoadedFont(latinFontPath) : primaryFont;
            const runs = splitRuns(titleEl.text);
            let totalAdvance = 0;
            const fSize = titleEl.fontSize || 15.375;
            for (const r of runs) {
              const activeFont = r.isIndic ? primaryFont : latinFont;
              const activeScale = fSize / (activeFont.unitsPerEm || 1000);
              const layoutRun = activeFont.layout(r.text);
              for (let j = 0; j < layoutRun.positions.length; j++) {
                totalAdvance += layoutRun.positions[j].xAdvance * activeScale;
              }
            }

            if (totalAdvance > 0) {
              const pillPaddingX = 38.08; // 3.2cqw * 2 = 6.4cqw = 38.08pt
              const exactPillWidth = Math.round(totalAdvance + pillPaddingX);
              const isCenter = el.pillAlign === 'center' || (el.align === 'center' && !el.pillAlign);
              const pillX = isCenter ? Math.round((595 - exactPillWidth) / 2) : (typeof el.x === 'number' ? el.x : 53);
              
              el.x = pillX;
              el.width = exactPillWidth;
              el.height = 24.5;
              el.cornerRadius = 12.25;

              titleEl.x = pillX;
              titleEl.width = exactPillWidth;
              titleEl.align = 'center';
              titleEl.y = el.y + 1.5;
            }
          } catch (layoutErr) {
            console.warn(`[SvgRenderer] Pill layout auto-fit error: ${layoutErr.message}`);
          }
        }
      }
    }
  }

  // Preserve canonical layer order by zIndex or array index
  elements.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  const defs = [];
  const bodyItems = [];
  let gradCounter = 0;
  let clipCounter = 0;

  // ── 1. Page Background ──────────────────────────────────────────────────────
  if (page.background) {
    const bg = page.background;
    if (bg.type === 'linearGradient' && bg.stops && bg.stops.length > 0) {
      const gradId = `bg_grad_${page.pageIndex || 0}`;
      const coords = angleToGradientCoords(typeof bg.angle === 'number' ? bg.angle : 0);
      const stopsXml = bg.stops
        .map((s) => `<stop offset="${Math.round(s.offset * 100)}%" stop-color="${s.color}" />`)
        .join('\n      ');
      defs.push(`
    <linearGradient id="${gradId}" x1="${coords.x1}" y1="${coords.y1}" x2="${coords.x2}" y2="${coords.y2}">
      ${stopsXml}
    </linearGradient>`);
      bodyItems.push(`<rect width="${width}" height="${height}" fill="url(#${gradId})" />`);
    } else if (bg.color) {
      bodyItems.push(`<rect width="${width}" height="${height}" fill="${bg.color}" />`);
    }
  }

  // ── 2. Render Elements ──────────────────────────────────────────────────────
  for (const el of elements) {
    if (!el || el.hidden) continue;

    const opacityAttr = el.opacity !== undefined && el.opacity < 1 ? ` opacity="${el.opacity}"` : '';
    let transformAttr = '';
    if (el.rotation && el.rotation !== 0) {
      const cx = el.x + (el.width || 0) / 2;
      const cy = el.y + (el.height || 0) / 2;
      transformAttr = ` transform="rotate(${el.rotation} ${cx} ${cy})"`;
    }

    switch (el.type) {
      // ── RECTANGLE ─────────────────────────────────────────────────────────
      case 'rect': {
        let fillValue = 'none';
        if (el.fill) {
          if (el.fill.type === 'linearGradient' && el.fill.stops) {
            const gid = `rect_grad_${++gradCounter}`;
            const coords = angleToGradientCoords(typeof el.fill.angle === 'number' ? el.fill.angle : 0);
            const stopsXml = el.fill.stops
              .map((s) => `<stop offset="${Math.round(s.offset * 100)}%" stop-color="${s.color}" />`)
              .join('\n      ');
            defs.push(`
    <linearGradient id="${gid}" x1="${coords.x1}" y1="${coords.y1}" x2="${coords.x2}" y2="${coords.y2}">
      ${stopsXml}
    </linearGradient>`);
            fillValue = `url(#${gid})`;
          } else if (el.fill.color) {
            fillValue = el.fill.color;
          }
        }

        const strokeAttr = el.stroke ? ` stroke="${el.stroke}"` : '';
        const strokeWidthAttr = el.strokeWidth ? ` stroke-width="${el.strokeWidth}"` : '';
        const rxAttr = el.cornerRadius ? ` rx="${el.cornerRadius}" ry="${el.cornerRadius}"` : '';

        bodyItems.push(
          `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${fillValue}"${rxAttr}${strokeAttr}${strokeWidthAttr}${opacityAttr}${transformAttr} />`
        );
        break;
      }

      // ── CIRCLE ────────────────────────────────────────────────────────────
      case 'circle': {
        const fillAttr = el.fill?.color ? ` fill="${el.fill.color}"` : ' fill="none"';
        const strokeAttr = el.stroke ? ` stroke="${el.stroke}"` : '';
        const strokeWidthAttr = el.strokeWidth ? ` stroke-width="${el.strokeWidth}"` : '';
        const r = el.radius || el.width / 2;
        const cx = el.x + r;
        const cy = el.y + r;
        bodyItems.push(
          `<circle cx="${cx}" cy="${cy}" r="${r}"${fillAttr}${strokeAttr}${strokeWidthAttr}${opacityAttr}${transformAttr} />`
        );
        break;
      }

      // ── PATH ──────────────────────────────────────────────────────────────
      case 'path': {
        const fillAttr = el.fill ? ` fill="${el.fill}"` : ' fill="none"';
        const strokeAttr = el.stroke ? ` stroke="${el.stroke}"` : '';
        const strokeWidthAttr = el.strokeWidth ? ` stroke-width="${el.strokeWidth}"` : '';
        bodyItems.push(
          `<path d="${el.d}"${fillAttr}${strokeAttr}${strokeWidthAttr}${opacityAttr}${transformAttr} />`
        );
        break;
      }

      // ── IMAGE ─────────────────────────────────────────────────────────────
      case 'image': {
        let clipPathAttr = '';
        if (el.cornerRadius && el.cornerRadius > 0) {
          const clipId = `clip_img_${++clipCounter}`;
          defs.push(`
    <clipPath id="${clipId}">
      <rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${el.cornerRadius}" ry="${el.cornerRadius}" />
    </clipPath>`);
          clipPathAttr = ` clip-path="url(#${clipId})"`;
        } else if (el.clipMode === 'circle') {
          const clipId = `clip_circle_${++clipCounter}`;
          const r = Math.min(el.width, el.height) / 2;
          defs.push(`
    <clipPath id="${clipId}">
      <circle cx="${el.x + el.width / 2}" cy="${el.y + el.height / 2}" r="${r}" />
    </clipPath>`);
          clipPathAttr = ` clip-path="url(#${clipId})"`;
        }

        // Determine preserveAspectRatio:
        // - Frame border (width 595, height 842): 'none' so frame fills the full canvas
        // - Profile photo: 'xMidYMid slice' (equivalent to object-fit: cover)
        // - Stickers, logos, icons: 'xMidYMid meet' (equivalent to object-fit: contain)
        let par = 'xMidYMid meet';
        if (el.id?.includes('frame') || (el.width >= 590 && el.height >= 840)) {
          par = 'none';
        } else if (el.objectFit === 'cover' || el.id?.includes('photo')) {
          par = 'xMidYMid slice';
        } else if (el.objectFit === 'fill') {
          par = 'none';
        }

        const imageHref = escapeXml(el.src);
        bodyItems.push(
          `<image href="${imageHref}" xlink:href="${imageHref}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" preserveAspectRatio="${par}"${clipPathAttr}${opacityAttr}${transformAttr} />`
        );

        // Optional photo border drawn cleanly on top of image
        if (el.borderColor && el.borderWidth) {
          const rxAttr = el.cornerRadius ? ` rx="${el.cornerRadius}" ry="${el.cornerRadius}"` : '';
          bodyItems.push(
            `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="none" stroke="${el.borderColor}" stroke-width="${el.borderWidth}"${rxAttr}${transformAttr} />`
          );
        }
        break;
      }

      // ── TEXT (NORMAL_TEXT & GRADIENT_TEXT) ─────────────────────────────────
      case 'text': {
        const textContent = escapeXml(el.text);
        let fontFamily = el.fontFamily || 'Poppins';

        // Critical Script Safety: If text contains Indic characters and current font doesn't support that script, use proper script font
        const hasIndic = /[\u0600-\u06FF\u0900-\u0D7F]/.test(el.text || '');
        const isHeading = el.id?.includes('header') || el.id?.includes('title') || el.id?.includes('mantra') || ((el.fontSize || 12) >= 15);
        if (hasIndic && !doesFontSupportScript(fontFamily, el.text)) {
          fontFamily = detectScriptFontFamily(el.text, 'Noto Sans Devanagari', isHeading);
        }
        const fontSize = el.fontSize || 12;
        const fontWeight = el.fontWeight || 400;
        const fontStyle = el.fontStyle || 'normal';
        const letterSpacing = el.letterSpacing ? ` letter-spacing="${el.letterSpacing}"` : '';

        // Text alignment & anchor
        let textAnchor = 'start';
        let textX = el.x;
        if (el.align === 'center') {
          textAnchor = 'middle';
          textX = el.x + el.width / 2;
        } else if (el.align === 'right') {
          textAnchor = 'end';
          textX = el.x + el.width;
        }

        // Font file check to ensure registered font
        let fontPath = null;
        try {
          fontPath = resolveFontFilePath(fontFamily, fontWeight);
        } catch (fontErr) {
          console.warn(`[SvgRenderer] Font warning: ${fontErr.message}`);
          try {
            fontPath = resolveFontFilePath('Noto Sans Devanagari', fontWeight);
          } catch {}
        }

        let latinFontPath = null;
        try {
          latinFontPath = resolveFontFilePath('Poppins', fontWeight);
        } catch {}

        // ── VECTOR GRADIENT TEXT (100% Vector, Zero Tofu Boxes in Chrome PDFium) ──
        const isGradientText = el.fill?.type === 'linearGradient' && el.fill.stops && el.fill.stops.length > 0;
        if (isGradientText && fontPath && el.text) {
          const res = textToVectorGlyphPaths(
            el.text,
            fontPath,
            fontSize,
            el.x,
            el.y,
            el.width || 525,
            el.align || 'left',
            el.lineHeight,
            latinFontPath
          );

          if (res && res.svgPaths) {
            const gid = `text_grad_${++gradCounter}`;
            const clipId = `text_clip_${++clipCounter}`;
            const angle = typeof el.fill.angle === 'number' ? el.fill.angle : 90;
            const coords = angleToGradientCoords(angle);

            const stopsXml = el.fill.stops
              .map((s) => `<stop offset="${Math.round(s.offset * 100)}%" stop-color="${s.color}" />`)
              .join('\n      ');

            defs.push(`
    <clipPath id="${clipId}">
      ${res.svgPaths}
    </clipPath>
    <linearGradient id="${gid}" x1="${coords.x1}" y1="${coords.y1}" x2="${coords.x2}" y2="${coords.y2}">
      ${stopsXml}
    </linearGradient>`);

            const rectX = res.startX - 1;
            const rectW = Math.max(1, (res.endX - res.startX) + 2);
            const effLineH = el.lineHeight || fontSize * 1.35;
            const rectY = el.y - 2;
            const lineCount = String(el.text).split('\n').length || 1;
            const rectH = Math.max(fontSize * 1.6, effLineH * lineCount + 4);

            bodyItems.push(
              `<rect id="${el.id || 'vector-text'}" x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" fill="url(#${gid})" clip-path="url(#${clipId})"${opacityAttr}${transformAttr} />`
            );
            break;
          }
        }

        // ── VECTOR INDIC TEXT (Zero Tofu Boxes & Perfect OpenType Shaping for Indic Scripts) ──
        if (hasIndic && fontPath && el.text) {
          const res = textToVectorGlyphPaths(
            el.text,
            fontPath,
            fontSize,
            el.x,
            el.y,
            el.width || 525,
            el.align || 'left',
            el.lineHeight,
            latinFontPath
          );

          if (res && res.svgPaths) {
            const fillColor = el.fill?.color || '#333333';
            bodyItems.push(
              `<g id="${el.id || 'indic-text'}" fill="${fillColor}"${opacityAttr}${transformAttr}>\n    ${res.svgPaths}\n  </g>`
            );
            break;
          }
        }

        // Fill color: Use solid color for glyphs to avoid Chrome PDFium pattern failure (tofu boxes)
        let fillAttr = ' fill="#333333"';
        if (el.fill?.color) {
          fillAttr = ` fill="${el.fill.color}"`;
        } else if (isGradientText) {
          fillAttr = ` fill="${el.fill.stops[0]?.color || '#9B1B30'}"`;
        }

        // Handle multi-line text cleanly
        const lines = String(el.text || '').split('\n');
        const lineHeight = el.lineHeight || fontSize * 1.35;

        if (lines.length <= 1) {
          bodyItems.push(
            `<text x="${textX}" y="${el.y}" text-anchor="${textAnchor}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" dominant-baseline="hanging"${letterSpacing}${fillAttr}${opacityAttr}${transformAttr}>${textContent}</text>`
          );
        } else {
          const tspans = lines
            .map((line, idx) => {
              const dy = idx === 0 ? 0 : lineHeight;
              return `<tspan x="${textX}" dy="${dy}">${escapeXml(line)}</tspan>`;
            })
            .join('');
          bodyItems.push(
            `<text x="${textX}" y="${el.y}" text-anchor="${textAnchor}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" dominant-baseline="hanging"${letterSpacing}${fillAttr}${opacityAttr}${transformAttr}>${tspans}</text>`
          );
        }
        break;
      }

      default:
        console.warn(`[SvgRenderer] Unsupported element type: "${el.type}"`);
        break;
    }
  }

  // ── 3. Assemble Final SVG ───────────────────────────────────────────────────
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}pt" height="${height}pt">
  <defs>${defs.join('')}
  </defs>
  ${bodyItems.join('\n  ')}
</svg>`;
}

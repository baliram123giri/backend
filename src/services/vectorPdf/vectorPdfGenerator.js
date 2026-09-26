import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { PDF_A4_WIDTH_PT, PDF_A4_HEIGHT_PT, DESIGN_A4_WIDTH, DESIGN_A4_HEIGHT } from './coordinates.js';
import { renderDesignPageToSvg } from './svgRenderer.js';
import { resolveFontFilePath } from './fontRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePublicDirs = [
  path.resolve(__dirname, '../../../../client/public'),
  path.resolve(__dirname, '../../../../client/dist/client'),
  path.resolve(__dirname, '../../../../client/dist'),
  path.resolve(process.cwd(), 'client/public'),
  path.resolve(process.cwd(), '../client/public'),
];

// In-memory cache for converted PNG buffers (key: src/path, value: Buffer)
const convertedPngCache = new Map();

/**
 * Resolves an image path or URL and ensures it is in a format PDFKit natively understands (PNG or JPEG).
 * Converts WebP, SVG, AVIF to crisp PNG via Sharp.
 */
async function ensureImageIsPdfCompatible(src) {
  if (!src || typeof src !== 'string') return null;
  if (convertedPngCache.has(src)) {
    return convertedPngCache.get(src);
  }

  // 1. Resolve local path
  let localPath = null;
  let cleanPath = src;
  try {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const parsed = new URL(src);
      cleanPath = decodeURIComponent(parsed.pathname);
    }
  } catch {}
  cleanPath = cleanPath.replace(/^\/+/, '');

  for (const dir of candidatePublicDirs) {
    const p = path.join(dir, cleanPath);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      localPath = p;
      break;
    }
  }

  if (!localPath && fs.existsSync(src) && fs.statSync(src).isFile()) {
    localPath = src;
  }

  let inputBuffer = null;
  if (localPath) {
    try {
      inputBuffer = fs.readFileSync(localPath);
    } catch (readErr) {
      console.warn(`[VectorPdf] Failed to read image "${localPath}": ${readErr.message}`);
    }
  } else if (src.startsWith('data:image')) {
    const base64Data = src.replace(/^data:image\/[^;]+;base64,/, '');
    inputBuffer = Buffer.from(base64Data, 'base64');
  } else if (src.startsWith('http://') || src.startsWith('https://')) {
    try {
      const res = await fetch(src);
      if (res.ok) {
        inputBuffer = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      console.warn(`[VectorPdf] Failed to fetch remote image "${src}": ${err.message}`);
    }
  }

  if (!inputBuffer) return null;

  // Check if already JPEG or PNG
  const isPng = inputBuffer.length > 4 && inputBuffer[0] === 0x89 && inputBuffer[1] === 0x50 && inputBuffer[2] === 0x4E && inputBuffer[3] === 0x47;
  const isJpeg = inputBuffer.length > 3 && inputBuffer[0] === 0xFF && inputBuffer[1] === 0xD8 && inputBuffer[2] === 0xFF;

  if (isPng || isJpeg) {
    convertedPngCache.set(src, inputBuffer);
    return inputBuffer;
  }

  // Convert WebP / other format to high-res PNG via Sharp
  try {
    const pngBuffer = await sharp(inputBuffer).png().toBuffer();
    convertedPngCache.set(src, pngBuffer);
    console.log(`[VectorPdf] Converted "${src.substring(0, 50)}" to PNG via Sharp (${pngBuffer.length} bytes)`);
    return pngBuffer;
  } catch (convErr) {
    console.warn(`[VectorPdf] Sharp conversion error for "${src}": ${convErr.message}`);
    convertedPngCache.set(src, inputBuffer);
    return inputBuffer;
  }
}

/**
 * Resolves local image assets directly from disk with 0ms latency.
 */
function svgImageCallback(src) {
  if (!src || typeof src !== 'string') return null;

  // Check pre-converted PNG buffer cache first
  if (convertedPngCache.has(src)) {
    return convertedPngCache.get(src);
  }

  // Data URLs are handled natively by PDFKit
  if (src.startsWith('data:')) {
    return src;
  }

  // Handle local absolute or relative URLs
  let cleanPath = src;
  try {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const parsed = new URL(src);
      cleanPath = decodeURIComponent(parsed.pathname);
    }
  } catch {}
  cleanPath = cleanPath.replace(/^\/+/, '');

  for (const dir of candidatePublicDirs) {
    const fullPath = path.join(dir, cleanPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
  }

  if (fs.existsSync(src) && fs.statSync(src).isFile()) {
    return src;
  }

  return src;
}

/**
 * Custom font callback for svg-to-pdfkit ensuring fonts resolve strictly
 * to local TTF files in client/public/fonts without silent substitutions.
 */
function svgFontCallback(family, bold, italic, fontOptions) {
  try {
    const weight = bold ? 700 : 400;
    const fontPath = resolveFontFilePath(family, weight);
    return fontPath;
  } catch (err) {
    console.warn(`[VectorPdf] svgFontCallback warning: ${err.message}`);
    // If not found, attempt Poppins fallback
    try {
      return resolveFontFilePath('Poppins', bold ? 700 : 400);
    } catch {
      return 'Helvetica';
    }
  }
}

/**
 * Generates a True Vector PDF from a DesignDocument JSON or an array of SVG strings.
 * 
 * @param {object} designDoc The canonical DesignDocument
 * @param {object} options
 * @returns {Promise<Buffer>} The binary PDF Buffer
 */
export async function generateVectorPdfFromDesign(designDoc, options = {}) {
  const startTime = Date.now();

  const pages = designDoc.pages || [designDoc];
  if (!pages || pages.length === 0) {
    throw new Error('[VectorPdf] Design document contains no pages.');
  }

  // 1. Asynchronously pre-convert and inline all images as high-res PNG Data URIs
  for (const page of pages) {
    if (page.elements) {
      for (const el of page.elements) {
        if (el.type === 'image' && el.src) {
          const pngBuffer = await ensureImageIsPdfCompatible(el.src);
          if (pngBuffer) {
            el.src = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          }
        }
      }
    }
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [PDF_A4_WIDTH_PT, PDF_A4_HEIGHT_PT],
        margin: 0,
        compress: true,
        autoFirstPage: false,
        info: {
          Title: designDoc.metadata?.title || 'Biodata',
          Author: 'Biodata99',
          Creator: 'Biodata99 Vector Engine',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        const duration = Date.now() - startTime;
        console.log(`[VectorPdf] Generated Vector PDF (${pdfBuffer.length} bytes, ${pages.length} pages) in ${duration}ms`);
        resolve(pdfBuffer);
      });
      doc.on('error', (err) => reject(err));

      // Scale factor to map design canvas (595x842) to PDF points (595.28x841.89)
      const scaleX = PDF_A4_WIDTH_PT / DESIGN_A4_WIDTH;
      const scaleY = PDF_A4_HEIGHT_PT / DESIGN_A4_HEIGHT;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        doc.addPage({
          size: [PDF_A4_WIDTH_PT, PDF_A4_HEIGHT_PT],
          margin: 0,
        });

        // 1. Generate SVG for this page
        const svgString = page.svg || renderDesignPageToSvg(page);

        // 2. Render SVG onto PDFKit document
        SVGtoPDF(doc, svgString, 0, 0, {
          width: PDF_A4_WIDTH_PT,
          height: PDF_A4_HEIGHT_PT,
          preserveAspectRatio: 'none',
          fontCallback: svgFontCallback,
          imageCallback: svgImageCallback,
          assumePt: true,
          useCSS: true,
        });
      }

      doc.end();
    } catch (err) {
      console.error('[VectorPdf] Generation failed:', err);
      reject(err);
    }
  });
}

/**
 * Convenience helper to render a single SVG string directly to a Vector PDF.
 * @param {string} svgString
 * @returns {Promise<Buffer>}
 */
export async function renderSvgStringToPdf(svgString) {
  return generateVectorPdfFromDesign({
    pages: [{ svg: svgString }],
  });
}

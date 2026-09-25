import puppeteer from 'puppeteer';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPrivateOrLocalHost } from '../lib/ssrf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePublicDirs = [
  path.resolve(__dirname, '../../../client/public'),
  path.resolve(__dirname, '../../../client/dist/client'),
  path.resolve(__dirname, '../../../client/dist'),
  path.resolve(__dirname, '../../../client/.wrangler/tmp/dev-XXXXXX'), // wrangler dev (pattern)
  path.resolve(process.cwd(), 'client/public'),
  path.resolve(process.cwd(), '../client/public'),
  path.resolve(process.cwd(), 'client/dist/client'),
  path.resolve(process.cwd(), '../client/dist/client'),
];


const mimeMap = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.css': 'text/css',
};

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // ── Windows: Check for installed Chrome / Chromium ───────────────────────
  if (process.platform === 'win32') {
    const winCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
        : null,
      // Chrome SxS (Canary)
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome SxS\\Application\\chrome.exe')
        : null,
      // Microsoft Edge as a fallback
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);

    for (const p of winCandidates) {
      try {
        if (fs.existsSync(p)) {
          return p;
        }
      } catch {}
    }
    // Let Puppeteer use its bundled Chromium on Windows if none found
    return undefined;
  }

  // ── Linux VPS: Auto-detect system-installed Chromium or Google Chrome ─────
  const candidatePaths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {}
  }

  return undefined;
}


// ─── Concurrency Semaphore (Protective 2-Slot Capacity) ──────────────────────
// VPS has 8GB shared with Jenkins, n8n, Postgres, Redis, PM2, etc.
// Max concurrent rendering capacity: 2 slots.
// Lightweight vector PDF jobs take 1 slot; heavy 2x raster Image/Combo jobs take 2 slots.
const MAX_CONCURRENT_CAPACITY = 2;
let activeWeight = 0;
const renderQueue = [];

function acquireSlot(weight = 1) {
  return new Promise((resolve) => {
    if (activeWeight + weight <= MAX_CONCURRENT_CAPACITY) {
      activeWeight += weight;
      resolve();
    } else {
      renderQueue.push({ resolve, weight });
    }
  });
}

let totalRenders = 0;
const MAX_RENDERS_BEFORE_RECYCLE = 200;

function incrementRenderAndCheckRecycle() {
  totalRenders++;
  if (totalRenders >= MAX_RENDERS_BEFORE_RECYCLE && activeWeight === 0 && browserInstance) {
    console.log(`[PDF Generator] Gracefully recycling Chromium after ${totalRenders} renders to free memory...`);
    const oldBrowser = browserInstance;
    browserInstance = null;
    totalRenders = 0;
    oldBrowser.close().catch(() => {});
  }
}

function releaseSlot(weight = 1) {
  activeWeight = Math.max(0, activeWeight - weight);
  incrementRenderAndCheckRecycle();
  while (renderQueue.length > 0 && activeWeight + renderQueue[0].weight <= MAX_CONCURRENT_CAPACITY) {
    const next = renderQueue.shift();
    activeWeight += next.weight;
    next.resolve();
  }
}

// ─── Chromium Singleton with Auto-Healing Watchdog ────────────────────────────
let browserInstance = null;
let isLaunching = false;
const launchWaiters = [];

export async function getChromiumBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  if (isLaunching) {
    return new Promise((resolve, reject) => {
      launchWaiters.push({ resolve, reject });
    });
  }

  isLaunching = true;
  try {
    console.log('[PDF Generator] Launching pre-warmed Chromium singleton...');
    const startTime = Date.now();

    const executablePath = resolveExecutablePath();
    if (executablePath) {
      console.log(`[PDF Generator] Using detected browser executable at: ${executablePath}`);
    }

    browserInstance = await puppeteer.launch({
      headless: 'new',
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Critical on Linux VPS to use /tmp instead of /dev/shm
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        '--font-render-hinting=medium',
        '--disable-web-security', // Allows cross-origin images/frames from CDN to render without taint
        '--js-flags=--max-old-space-size=512', // Caps V8 heap within Chromium to prevent memory ballooning
      ],
    });

    console.log(`[PDF Generator] Chromium launched successfully in ${Date.now() - startTime}ms`);

    browserInstance.on('disconnected', () => {
      console.warn('[PDF Generator] Chromium instance disconnected. Resetting singleton for auto-recovery...');
      browserInstance = null;
    });

    while (launchWaiters.length > 0) {
      launchWaiters.shift().resolve(browserInstance);
    }

    return browserInstance;
  } catch (launchErr) {
    console.error('[PDF Generator] Failed to launch Chromium:', launchErr);
    while (launchWaiters.length > 0) {
      launchWaiters.shift().reject(launchErr);
    }
    throw launchErr;
  } finally {
    isLaunching = false;
  }
}

export async function closeChromiumBrowser() {
  if (browserInstance) {
    try {
      console.log('[PDF Generator] Closing Chromium singleton gracefully...');
      const b = browserInstance;
      browserInstance = null;
      await b.close();
    } catch (err) {
      console.warn('[PDF Generator] Error closing Chromium browser:', err.message);
    }
  }
}

// ─── Puppeteer SSRF & LFI Security Sandbox Interceptor ────────────────────────
export async function setupPageSecurity(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      if (typeof req.isInterceptResolutionHandled === 'function' && req.isInterceptResolutionHandled()) {
        return;
      }

      const urlStr = req.url();

      // Allow safe in-memory data and blob URLs
      if (urlStr.startsWith('data:') || urlStr.startsWith('blob:') || urlStr === 'about:blank') {
        return req.continue().catch(() => {});
      }

      // Block file: protocol and any non-http(s) schemes immediately (prevents LFI)
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        return req.abort('blockedbyclient').catch(() => {});
      }

      const parsedUrl = new URL(urlStr);
      const hostname = parsedUrl.hostname.toLowerCase();
      const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);

      // 1a. Directly fulfill local static assets from disk (0ms latency, works for dev & production)
      const pathname = decodeURIComponent(parsedUrl.pathname);
      for (const dir of candidatePublicDirs) {
        const localPath = path.join(dir, pathname);
        if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
          const ext = path.extname(localPath).toLowerCase();
          const contentType = mimeMap[ext] || 'application/octet-stream';
          return req.respond({
            status: 200,
            contentType,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: fs.readFileSync(localPath),
          }).catch(() => {});
        }
      }

      // 1b. Allow localhost / loopback requests to the application's dev/preview and API servers
      const isLoopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.localhost');

      if (isLoopback) {
        // Only allow web ports: Astro preview (4321), Fastify backend (4000), Vite (5173), Next (3000), standard HTTP(S)
        const allowedAppPorts = [4321, 4000, 3000, 5173, 80, 443, 8080, 8443];
        if (process.env.PORT) {
          allowedAppPorts.push(Number(process.env.PORT));
        }
        if (!allowedAppPorts.includes(port)) {
          return req.abort('accessdenied').catch(() => {});
        }

        // Strictly block sensitive admin/diagnostic/system paths on localhost
        const blockedLocalPrefixes = ['/api/admin', '/diagnostic', '/health', '/metrics', '/env'];
        if (blockedLocalPrefixes.some((prefix) => parsedUrl.pathname.toLowerCase().startsWith(prefix))) {
          return req.abort('accessdenied').catch(() => {});
        }

        // Fallback: Fetch via Node's native fetch (bypasses browser Sec-Fetch-Site & CORS restrictions)
        fetch(urlStr).then(async (res) => {
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            return req.respond({
              status: res.status,
              contentType,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: buffer,
            }).catch(() => {});
          }
          return req.continue().catch(() => {});
        }).catch(() => {
          req.continue().catch(() => {});
        });
        return;
      }

      // 2. Block internal / private / cloud-metadata network requests (prevents SSRF)
      if (isPrivateOrLocalHost(hostname)) {
        return req.abort('accessdenied').catch(() => {});
      }

      // 3. Block non-standard or internal service ports for external hosts
      const allowedPorts = [80, 443, 8080, 8443];
      if (!allowedPorts.includes(port)) {
        return req.abort('accessdenied').catch(() => {});
      }

      return req.continue().catch(() => {});
    } catch {
      try {
        req.abort('failed').catch(() => {});
      } catch {}
    }
  });
}

/**
 * Ensures web fonts and all <img> elements are completely loaded and decoded
 * before capturing PDF or taking screenshots.
 */
async function waitForAssets(page) {
  try {
    await page.evaluate(async () => {
      // 1. Wait for web fonts
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      // 2. Wait for all images to fully load and decode naturally
      const images = Array.from(document.querySelectorAll('img'));
      await Promise.all(
        images.map((img) => {
          if (img.complete) {
            return typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve();
          }
          return new Promise((resolve) => {
            img.addEventListener('load', () => {
              if (typeof img.decode === 'function') {
                img.decode().catch(() => {}).finally(resolve);
              } else {
                resolve();
              }
            }, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        })
      );
    });
  } catch {}
}


// ─── HTML Normalization & CSS Guarantees ───────────────────────────────────────
const GUARANTEE_CSS = `
  *, ::before, ::after { box-sizing: border-box; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: 210mm !important;
    height: 297mm !important;
    background: white !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  @page {
    size: 210mm 297mm;
    margin: 0 !important;
  }
  .__bppage-container__ {
    width: 210mm !important;
    height: 297mm !important;
    position: relative !important;
    overflow: hidden !important;
    background: transparent !important; /* Set dynamically by propagateTemplateBackground() */
    page-break-after: always !important;
    break-after: page !important;
  }
  /* Full-bleed background layer injected by propagateTemplateBackground() to
     cover sub-pixel hairline gaps at edges of transform:scale() content */
  .__bppage-bg__ {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    z-index: 0 !important;
    pointer-events: none !important;
  }
  .__bppage-scale__ {
    width: 595px !important;
    height: 842px !important;
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    transform: scale(1.33445) !important;
    transform-origin: top left !important;
    container-type: inline-size !important;
    container-name: a4 !important;
    z-index: 1 !important;
  }
  .__bppage-scale__ > div,
  .__bppage-scale__ > div > div {
    width: 595px !important;
    height: 842px !important;
    position: relative !important;
    container-type: inline-size !important;
  }
  /* Layout & typography primitives */
  .absolute { position: absolute !important; }
  .relative { position: relative !important; }
  .inset-0 { top: 0px !important; right: 0px !important; bottom: 0px !important; left: 0px !important; }
  .flex { display: flex !important; }
  .inline-flex { display: inline-flex !important; }
  .flex-col { flex-direction: column !important; }
  .items-center { align-items: center !important; }
  .items-start { align-items: flex-start !important; }
  .justify-center { justify-content: center !important; }
  .flex-1 { flex: 1 1 0% !important; }
  .shrink-0 { flex-shrink: 0 !important; }
  .text-center { text-align: center !important; }
  .font-bold { font-weight: 700 !important; }
  .font-black { font-weight: 900 !important; }
  .uppercase { text-transform: uppercase !important; }
  .w-full { width: 100% !important; }
  .h-full { height: 100% !important; }
  .min-w-0 { min-width: 0px !important; }
  .overflow-hidden { overflow: hidden !important; }
  .rounded-full { border-radius: 9999px !important; }
  .whitespace-nowrap { white-space: nowrap !important; }
  .whitespace-pre-wrap { white-space: pre-wrap !important; }
  .break-words { overflow-wrap: break-word !important; }
  .pointer-events-none { pointer-events: none !important; }
  .select-none { user-select: none !important; }
  .select-text { user-select: text !important; }
  /* Critical z-index hierarchy: text container (.z-20) MUST sit above background frame image (z-index: 1) */
  .z-10 { z-index: 10 !important; }
  .z-20 { z-index: 20 !important; }
  .z-30 { z-index: 30 !important; }
  .z-40 { z-index: 40 !important; }
  .z-50 { z-index: 50 !important; }

  /* ── Sub-pixel hairline gap fix ─────────────────────────────────────────────
     ROOT CAUSE: Chromium's PDF rasterizer uses floating-point math when scaling
     the transform:scale() container. The .__bppage-container__ background
     (white) shows through as a hairline at the edges of the scaled content.

     CORRECT FIX:
     • Make .__bppage-container__ background TRANSPARENT (not white). This means
       any fractional-pixel gap at the container edge shows html/body background
       instead of white — which we set to match the template via page.evaluate().
     • Keep .__bppage-scale__ dimensions exactly as 595x842 with NO padding/margin
       changes (those would break container-query cqw measurements).
     • DO NOT add transform:translateZ(0) to gradient children — that creates
       new stacking contexts that break Chromium's PDF vector rendering pipeline.
     • Background propagation is done via page.evaluate() in the render functions
       (guaranteed to run before page.pdf()), not via script tags.
  ── */
`;


async function propagateTemplateBackground(page) {
  // Reads the actual template background color/gradient from the rendered DOM
  // and applies it via two complementary strategies to eliminate sub-pixel
  // hairline gaps caused by Chromium's PDF rasterizer floating-point rounding:
  //
  // Strategy A — Container background propagation (solid colors):
  //   Sets html, body, .__bppage-container__ to match the template bg.
  //   Works perfectly for solid colors.
  //
  // Strategy B — Full-bleed __bppage-bg__ layer (gradients + all templates):
  //   Injects a position:absolute div that fills the ENTIRE .__bppage-container__
  //   (210mm × 297mm) with the same gradient. Since it's at the container level
  //   (not inside the scaled transform), it perfectly covers any sub-pixel gap
  //   at the edges of the scaled content without any color mismatch.
  try {
    await page.evaluate(() => {
      const containers = document.querySelectorAll('.__bppage-container__');
      containers.forEach((container) => {
        const scaleDiv = container.querySelector('.__bppage-scale__');
        if (!scaleDiv) return;

        // Search up to 4 levels deep for the element with the actual background
        let bg = '';
        const candidates = [
          scaleDiv.firstElementChild,
          scaleDiv.firstElementChild?.firstElementChild,
          scaleDiv.firstElementChild?.firstElementChild?.firstElementChild,
          scaleDiv,
        ].filter(Boolean);

        for (const el of candidates) {
          // Prefer inline style (most reliable — React sets it directly)
          const inline = el.style.background || el.style.backgroundColor || '';
          if (inline && inline !== 'rgba(0, 0, 0, 0)' && inline !== 'transparent') {
            bg = inline;
            break;
          }
          // Fall back to computed style
          const cs = window.getComputedStyle(el);
          const bgImg = cs.backgroundImage;
          const bgCol = cs.backgroundColor;
          // Prefer backgroundImage (catches gradient) over backgroundColor
          if (bgImg && bgImg !== 'none') {
            // Compose full background shorthand for gradients
            bg = bgImg + (bgCol && bgCol !== 'rgba(0, 0, 0, 0)' ? ' ' + bgCol : '');
            break;
          }
          if (bgCol && bgCol !== 'rgba(0, 0, 0, 0)' && bgCol !== 'transparent') {
            bg = bgCol;
            break;
          }
        }

        if (!bg) return; // No background found — leave defaults

        // ── Strategy A: propagate to ancestor containers ──────────────────────
        document.documentElement.style.setProperty('background', bg, 'important');
        document.body.style.setProperty('background', bg, 'important');
        container.style.setProperty('background', bg, 'important');

        // ── Strategy B: inject or update a full-bleed background layer ────────
        // This div sits BEHIND the scaled content inside .__bppage-container__
        // and covers the full 210mm×297mm area. Because it is NOT inside the
        // transform:scale() element, it fills the entire container perfectly
        // and eliminates any sub-pixel gap at the edges of the scaled content.
        let bgLayer = container.querySelector('.__bppage-bg__');
        if (!bgLayer) {
          bgLayer = document.createElement('div');
          bgLayer.className = '__bppage-bg__';
          // Insert before scaleDiv so it renders behind everything
          container.insertBefore(bgLayer, scaleDiv);
        }
        bgLayer.style.setProperty('background', bg, 'important');
        bgLayer.style.setProperty('position', 'absolute', 'important');
        bgLayer.style.setProperty('inset', '0', 'important');
        bgLayer.style.setProperty('width', '100%', 'important');
        bgLayer.style.setProperty('height', '100%', 'important');
        bgLayer.style.setProperty('z-index', '0', 'important');
        bgLayer.style.setProperty('pointer-events', 'none', 'important');
      });
    });
  } catch (err) {
    // Non-fatal — proceed with PDF generation even if propagation fails
    console.warn('[PDF Generator] Background propagation skipped:', err.message);
  }
}

export function prepareNormalizedHtml(fullHtml) {
  let normalizedHtml = fullHtml || '';
  if (normalizedHtml.includes('class="__bppage__"')) {
    normalizedHtml = normalizedHtml.replace(/<div class="__bppage__">/g, '<div class="__bppage-container__"><div class="__bppage-scale__">');
    normalizedHtml = normalizedHtml.replace(/<\/body>/i, '</div></div></body>');
  }

  // Strip <base href="..."> and rewrite relative URLs to absolute.
  // In Chromium/Puppeteer, <base href="..."> breaks all SVG fragment references (e.g. fill="url(#id)"),
  // causing gradient headers/text to render completely blank/invisible.
  const baseMatch = normalizedHtml.match(/<base\s+[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (baseMatch) {
    const baseHref = baseMatch[1].replace(/\/+$/, '');
    normalizedHtml = normalizedHtml.replace(/(src|href)=["']\/(?!\/)([^"']*)["']/gi, `$1="${baseHref}/$2"`);
    normalizedHtml = normalizedHtml.replace(/url\((['"]?)\/(?!\/)([^'")]+)\1\)/gi, `url($1${baseHref}/$2$1)`);
    normalizedHtml = normalizedHtml.replace(/<base\s+[^>]*>/gi, '');
  }

  if (normalizedHtml.includes('</head>')) {
    normalizedHtml = normalizedHtml.replace('</head>', `<style>${GUARANTEE_CSS}</style></head>`);
  } else {
    normalizedHtml = `<style>${GUARANTEE_CSS}</style>` + normalizedHtml;
  }

  return normalizedHtml;
}

// ─── Render HTML to Vector PDF ────────────────────────────────────────────────
export async function renderHtmlToVectorPdf(fullHtml, options = {}) {
  const queueStart = Date.now();
  await acquireSlot(1);
  const queueWaitMs = Date.now() - queueStart;

  const renderStart = Date.now();
  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await getChromiumBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);
    await setupPageSecurity(page);

    // 2x device scale ensures crisp ~192 DPI resolution for frames, photos, and embedded raster assets
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 180000,
    });

    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 150)); // Settle after background propagation

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Vector PDF created: ${pdfBuffer.length} bytes in ${totalTimeMs}ms (queue wait: ${queueWaitMs}ms, activeWeight: ${activeWeight})`
    );

    return pdfBuffer;
  } catch (error) {
    console.error('[PDF Generator] Error generating vector PDF:', error);
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    releaseSlot(1);
  }
}

// ─── Render HTML to Combo ZIP (PDF + PNG + JPEG) ──────────────────────────────
export async function renderHtmlToComboZip(fullHtml, options = {}) {
  const { cleanName = 'Biodata' } = options;
  const queueStart = Date.now();
  await acquireSlot(2);
  const queueWaitMs = Date.now() - queueStart;

  const renderStart = Date.now();
  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await getChromiumBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);
    await setupPageSecurity(page);

    // 2x device scale for razor-sharp ~192 DPI PNG and JPEG images
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    });

    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 180000,
    });

    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 150)); // Settle after background propagation

    // 1. True Vector PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });

    // 2. High-res PNG & JPEG
    const pngBuffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 794, height: 1123 },
    });

    const jpegBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 95,
      clip: { x: 0, y: 0, width: 794, height: 1123 },
    });

    // 3. Package into valid .zip with JSZip using STORE (prevents CPU thrash on already-compressed media)
    const zip = new JSZip();
    zip.file(`${cleanName}.pdf`, pdfBuffer);
    zip.file(`${cleanName}.png`, pngBuffer);
    zip.file(`${cleanName}.jpg`, jpegBuffer);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    });

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Combo ZIP created: ${zipBuffer.length} bytes in ${totalTimeMs}ms (queue wait: ${queueWaitMs}ms)`
    );

    return zipBuffer;
  } catch (error) {
    console.error('[PDF Generator] Error generating combo zip:', error);
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    releaseSlot(2);
  }
}

// ─── Render HTML to Image (PNG or JPEG) ───────────────────────────────────────
export async function renderHtmlToImage(fullHtml, format = 'png', options = {}) {
  const { pageIndex = 0, cleanName = 'Biodata', totalPages = 1, bundleZip = false } = options;
  const queueStart = Date.now();
  await acquireSlot(2);
  const queueWaitMs = Date.now() - queueStart;

  const renderStart = Date.now();
  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await getChromiumBrowser();
    context = await browser.createBrowserContext();
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);
    await setupPageSecurity(page);

    const isJpeg = format.toLowerCase() === 'jpg' || format.toLowerCase() === 'jpeg';
    const pagesCount = Math.max(1, Number(totalPages) || 1);

    // Keep single A4 viewport (794x1123) to avoid huge raster surface allocation in Chromium
    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 2, // 2x device scale for ~192 DPI crisp image exports
    });

    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 180000,
    });

    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 150)); // Settle after background propagation

    // Multi-page bundle as ZIP: captures one A4 page at a time without inflating viewport
    if (pagesCount > 1 && bundleZip) {
      const zip = new JSZip();
      const ext = isJpeg ? 'jpg' : 'png';
      const pageContainers = await page.$$('.__bppage-container__');

      for (let i = 0; i < pagesCount; i++) {
        let buf;
        if (pageContainers[i]) {
          buf = await pageContainers[i].screenshot({
            type: isJpeg ? 'jpeg' : 'png',
            quality: isJpeg ? 95 : undefined,
          });
        } else {
          await page.evaluate((idx) => window.scrollTo(0, idx * 1123), i);
          buf = await page.screenshot({
            type: isJpeg ? 'jpeg' : 'png',
            quality: isJpeg ? 95 : undefined,
            clip: { x: 0, y: 0, width: 794, height: 1123 },
          });
        }
        zip.file(`${cleanName}_Page_${i + 1}.${ext}`, buf);
      }

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'STORE',
      });
      return { isZip: true, buffer: zipBuffer };
    }

    // Single page capture: captures target page safely
    const safePageIndex = Math.max(0, Number(pageIndex) || 0);
    const pageContainers = await page.$$('.__bppage-container__');
    let imgBuffer;

    if (pageContainers[safePageIndex]) {
      imgBuffer = await pageContainers[safePageIndex].screenshot({
        type: isJpeg ? 'jpeg' : 'png',
        quality: isJpeg ? 95 : undefined,
      });
    } else {
      await page.evaluate((idx) => window.scrollTo(0, idx * 1123), safePageIndex);
      imgBuffer = await page.screenshot({
        type: isJpeg ? 'jpeg' : 'png',
        quality: isJpeg ? 95 : undefined,
        clip: { x: 0, y: 0, width: 794, height: 1123 },
      });
    }

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Image (${format.toUpperCase()}) created: ${imgBuffer.length} bytes in ${totalTimeMs}ms (queue wait: ${queueWaitMs}ms)`
    );

    return { isZip: false, buffer: imgBuffer };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    releaseSlot(2);
  }
}


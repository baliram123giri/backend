import puppeteer from 'puppeteer';
import JSZip from 'jszip';
import { isPrivateOrLocalHost } from '../lib/ssrf.js';

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

    browserInstance = await puppeteer.launch({
      headless: 'new',
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

      // 1. Allow localhost / loopback requests to the application's dev/preview and API servers
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

        // Allow legitimate application assets (frames, stickers, fonts, proxy, uploads)
        return req.continue().catch(() => {});
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

      // 2. Wait for all images to fully load and decode
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
    background: white !important;
    page-break-after: always !important;
    break-after: page !important;
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
`;

export function prepareNormalizedHtml(fullHtml) {
  let normalizedHtml = fullHtml || '';
  if (normalizedHtml.includes('class="__bppage__"')) {
    normalizedHtml = normalizedHtml.replace(/<div class="__bppage__">/g, '<div class="__bppage-container__"><div class="__bppage-scale__">');
    normalizedHtml = normalizedHtml.replace(/<\/body>/i, '</div></div></body>');
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
    await setupPageSecurity(page);

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 1,
    });

    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 8000,
    });

    await waitForAssets(page);
    await new Promise((r) => setTimeout(r, 60));

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
      timeout: 8000,
    });

    await waitForAssets(page);
    await new Promise((r) => setTimeout(r, 60));

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
      timeout: 8000,
    });

    await waitForAssets(page);
    await new Promise((r) => setTimeout(r, 60));

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


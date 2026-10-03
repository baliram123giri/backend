import puppeteer from 'puppeteer';
import JSZip from 'jszip';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPrivateOrLocalHost } from '../lib/ssrf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePublicDirs = [
  process.env.STATIC_DIR,
  process.env.STATIC_ASSETS_DIR,
  '/var/www/biodata99/client/dist',
  '/var/www/biodata99/client/public',
  '/var/www/biodata99/dist',
  path.resolve(__dirname, '../../assets'),
  path.resolve(process.cwd(), 'assets'),
  path.resolve(__dirname, '../../../client/public'),
  path.resolve(__dirname, '../../../client/dist/client'),
  path.resolve(__dirname, '../../../client/dist'),
  path.resolve(process.cwd(), '../client/public'),
  path.resolve(process.cwd(), '../client/dist/client'),
  path.resolve(process.cwd(), 'public'),
].filter(Boolean).filter((dir) => {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
});

// In-memory cache for static assets (fonts, frames, stickers) to achieve 0ms response
const assetBufferCache = new Map();


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
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync',
        '--run-all-compositor-stages-before-draw',
        '--enable-surface-synchronization',
        '--disable-threaded-scrolling',
        '--disable-threaded-animation',
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

    setTimeout(() => warmIdlePage().catch(() => {}), 50);

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
  if (idlePage) {
    await idlePage.close().catch(() => {});
    idlePage = null;
  }
  if (idlePageContext) {
    await idlePageContext.close().catch(() => {});
    idlePageContext = null;
  }
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
      // Allow relative/about asset paths for fonts/frames/stickers
      const isKnownStaticAsset =
        urlStr.includes('/fonts/') ||
        urlStr.includes('/frames/') ||
        urlStr.includes('/stickers/') ||
        urlStr.includes('/thumbnails/');

      if (!isKnownStaticAsset && !urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        return req.abort('blockedbyclient').catch(() => {});
      }

      const parsedUrl = new URL(urlStr.startsWith('http') ? urlStr : `https://biodata99.com/${urlStr.replace(/^about:\/?\/?/, '')}`);
      const hostname = parsedUrl.hostname.toLowerCase();
      const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
      const pathname = decodeURIComponent(parsedUrl.pathname);

      // Block redundant external analytics, external Google Fonts (inlined as Base64), and Astro client CSS
      if (
        hostname.includes('google-analytics') ||
        hostname.includes('googletagmanager') ||
        hostname.includes('doubleclick') ||
        hostname.includes('fonts.googleapis.com') ||
        hostname.includes('fonts.gstatic.com') ||
        pathname.includes('/_astro/')
      ) {
        return req.abort('blockedbyclient').catch(() => {});
      }

      // 1a. Directly fulfill local static assets from memory or disk (0ms latency, works for dev & production)
      const cleanRelPath = pathname
        .replace(/^\/+/, '')
        .replace(/^(?:biodata|matrimonial)\/+/, '');

      if (assetBufferCache.has(cleanRelPath)) {
        const cached = assetBufferCache.get(cleanRelPath);
        return req.respond({
          status: 200,
          contentType: cached.contentType,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: cached.body,
        }).catch(() => {});
      }

      for (const dir of candidatePublicDirs) {
        const testPaths = [
          path.join(dir, cleanRelPath),
          path.join(dir, cleanRelPath.replace(/^assets\/+/, '')),
        ];
        for (const localPath of testPaths) {
          if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
            const ext = path.extname(localPath).toLowerCase();
            const contentType = mimeMap[ext] || 'application/octet-stream';
            const fileBuffer = fs.readFileSync(localPath);
            assetBufferCache.set(cleanRelPath, { contentType, body: fileBuffer });
            return req.respond({
              status: 200,
              contentType,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: fileBuffer,
            }).catch(() => {});
          }
        }
      }

      // 1b. Allow localhost / loopback requests and internal routing for app domain (bypasses Cloudflare hairpin stalls)
      const isAppDomain =
        hostname === 'biodata99.com' ||
        hostname.endsWith('.biodata99.com') ||
        (process.env.APP_DOMAIN && (hostname === process.env.APP_DOMAIN || hostname.endsWith(`.${process.env.APP_DOMAIN}`)));

      const isLoopback =
        isAppDomain ||
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.localhost');

      if (isLoopback) {
        // Only allow web ports: Astro preview (4321), Fastify backend (4000/5000), Vite (5173), Next (3000), standard HTTP(S)
        const allowedAppPorts = [4321, 4000, 5000, 3000, 5173, 80, 443, 8080, 8443];
        if (process.env.PORT) {
          allowedAppPorts.push(Number(process.env.PORT));
        }
        if (!isAppDomain && !allowedAppPorts.includes(port)) {
          return req.abort('accessdenied').catch(() => {});
        }

        // Strictly block sensitive admin/diagnostic/system paths on localhost
        const blockedLocalPrefixes = ['/api/admin', '/diagnostic', '/health', '/metrics', '/env'];
        if (blockedLocalPrefixes.some((prefix) => parsedUrl.pathname.toLowerCase().startsWith(prefix))) {
          return req.abort('accessdenied').catch(() => {});
        }

        // Fetch via Node's native fetch (routes /api/ locally to bypass Cloudflare; fetches external assets with browser UA)
        const isBackendApi = parsedUrl.pathname.startsWith('/api/');
        const localBackendPort = process.env.PORT || 5000;
        const safeUrl = (isAppDomain && isBackendApi)
          ? `http://127.0.0.1:${localBackendPort}${parsedUrl.pathname}${parsedUrl.search}`
          : urlStr
              .replace('//localhost:', '//127.0.0.1:')
              .replace('//[::1]:', '//127.0.0.1:');

        const fetchTimeout = pathname.includes('proxy-logo') ? 1500 : 2500;
        fetch(safeUrl, {
          signal: AbortSignal.timeout(fetchTimeout),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        }).then(async (res) => {
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            assetBufferCache.set(cleanRelPath, { contentType, body: buffer });
            return req.respond({
              status: res.status,
              contentType,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: buffer,
            }).catch(() => {});
          }
          if (pathname.includes('proxy-logo')) {
            return req.abort('failed').catch(() => {});
          }
          return req.continue().catch(() => {});
        }).catch(() => {
          if (pathname.includes('proxy-logo')) {
            return req.abort('failed').catch(() => {});
          }
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

// ─── Pre-Warmed Idle Page Pool ───────────────────────────────────────────────
// Keeps 1 pre-warmed, secured, configured page ready in memory.
// When an export request arrives, it acquires this page in 0ms!
// While the export is in progress, the pool immediately pre-warms the next page in the background.

let idlePageContext = null;
let idlePage = null;
let isWarmingPage = false;

async function prepareFreshPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  page.setDefaultNavigationTimeout(180000);
  await setupPageSecurity(page);
  await page.setViewport({
    width: 794,
    height: 1123,
    deviceScaleFactor: 2,
  });
  return { context, page };
}

export async function warmIdlePage() {
  if (idlePage || isWarmingPage || !browserInstance || !browserInstance.connected) return;
  isWarmingPage = true;
  try {
    const { context, page } = await prepareFreshPage(browserInstance);
    if (!browserInstance || !browserInstance.connected) {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      return;
    }
    idlePageContext = context;
    idlePage = page;
  } catch (err) {
    console.warn('[PDF Generator] Idle page pre-warm warning:', err.message);
  } finally {
    isWarmingPage = false;
  }
}

async function acquirePage() {
  const browser = await getChromiumBrowser();

  // If a pre-warmed idle page is ready, claim it instantly in 0ms!
  if (idlePage && idlePageContext && !idlePage.isClosed()) {
    const claimedPage = idlePage;
    const claimedContext = idlePageContext;
    idlePage = null;
    idlePageContext = null;

    // Trigger pre-warming next page in background for the next request
    setTimeout(() => warmIdlePage().catch(() => {}), 50);

    return { browser, context: claimedContext, page: claimedPage, isPrewarmed: true };
  }

  // Fallback: prepare fresh page on the fly
  const { context, page } = await prepareFreshPage(browser);
  setTimeout(() => warmIdlePage().catch(() => {}), 50);
  return { browser, context, page, isPrewarmed: false };
}

/**
 * Ensures web fonts and all <img> elements are completely loaded and decoded
 * before capturing PDF or taking screenshots. Includes safe timeouts so broken
 * external URLs never hang the render queue.
 */
async function waitForAssets(page) {
  try {
    await page.evaluate(async () => {
      // 1. Wait for web fonts (document.fonts.ready resolves matching DOM fonts without loading all 44 unused fonts)
      if (document.fonts) {
        try {
          await Promise.race([
            document.fonts.ready,
            new Promise((res) => setTimeout(res, 800)),
          ]);
        } catch {}
      }

      // 2. Wait for real <img> elements to fully load and decode (skip empty/broken/stub tags)
      const images = Array.from(document.querySelectorAll('img'));
      await Promise.all(
        images.map((img) => {
          const src = (img.src || '').trim();
          // Skip empty or placeholder src attributes immediately
          if (!src || src === window.location.href || src.endsWith('#') || src === 'about:blank') {
            return Promise.resolve();
          }
          const isLogo = img.dataset?.logoImg === 'true' || src.includes('proxy-logo');
          if (img.complete) {
            if ((img.naturalWidth === 0 || (isLogo && img.naturalWidth <= 1)) && !src.startsWith('data:image/svg')) {
              if (isLogo) {
                try { img.remove(); } catch {}
              }
              return Promise.resolve(); // Broken image, don't wait
            }
            return typeof img.decode === 'function'
              ? Promise.race([img.decode(), new Promise((r) => setTimeout(r, 400))]).catch(() => {})
              : Promise.resolve();
          }
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              if (isLogo) {
                try { img.remove(); } catch {}
              }
              resolve();
            }, isLogo ? 300 : 600); // 300ms max wait for logo, 600ms for other images
            img.addEventListener('load', () => {
              clearTimeout(timer);
              if (isLogo && (img.naturalWidth <= 1 || img.naturalHeight <= 1)) {
                try { img.remove(); } catch {}
                resolve();
                return;
              }
              if (typeof img.decode === 'function') {
                Promise.race([img.decode(), new Promise((r) => setTimeout(r, 300))])
                  .catch(() => {})
                  .finally(resolve);
              } else {
                resolve();
              }
            }, { once: true });
            img.addEventListener('error', () => {
              clearTimeout(timer);
              if (isLogo) {
                try { img.remove(); } catch {}
              }
              resolve();
            }, { once: true });
          });
        })
      );
    });
  } catch {}
}


// ─── Embedded Base64 Font Engine for 100% Offline Vector PDF & Image Rendering ───
const candidateFontDirs = [
  process.env.FONTS_DIR,
  '/var/www/biodata99/client/public/fonts',
  '/var/www/biodata99/client/dist/fonts',
  path.resolve(__dirname, '../../assets/fonts'),
  path.resolve(process.cwd(), 'assets/fonts'),
  path.resolve(__dirname, '../../../client/public/fonts'),
  path.resolve(process.cwd(), '../client/public/fonts'),
  path.resolve(process.cwd(), 'public/fonts'),
].filter(Boolean).filter((dir) => {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
});

const fontDataUrlCache = new Map();

function getFontDataUrl(filename, mimeType = 'font/truetype') {
  if (fontDataUrlCache.has(filename)) {
    return fontDataUrlCache.get(filename);
  }
  for (const dir of candidateFontDirs) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      try {
        const b64 = fs.readFileSync(fullPath).toString('base64');
        const dataUrl = `data:${mimeType};charset=utf-8;base64,${b64}`;
        fontDataUrlCache.set(filename, dataUrl);
        return dataUrl;
      } catch {}
    }
  }
  return null;
}

const FONT_MAP = [
  {
    family: 'Great Vibes',
    files: [{ file: 'GreatVibes-Regular.ttf', mime: 'font/truetype', weight: '400' }],
    aliases: ['great vibes', 'greatvibes'],
  },
  {
    family: 'Alex Brush',
    files: [{ file: 'GreatVibes-Regular.ttf', mime: 'font/truetype', weight: '400' }],
    aliases: ['alex brush', 'alexbrush'],
  },
  {
    family: 'Sacramento',
    files: [{ file: 'GreatVibes-Regular.ttf', mime: 'font/truetype', weight: '400' }],
    aliases: ['sacramento'],
  },
  {
    family: 'Poppins',
    files: [
      { file: 'poppins-400.woff2', fallback: 'Poppins-Regular.ttf', mime: 'font/woff2', weight: '100 400' },
      { file: 'poppins-600.woff2', fallback: 'Poppins-SemiBold.ttf', mime: 'font/woff2', weight: '500 600' },
      { file: 'poppins-700.woff2', fallback: 'Poppins-Bold.ttf', mime: 'font/woff2', weight: '700 900' },
    ],
    aliases: ['poppins'],
  },
  {
    family: 'Cinzel',
    files: [
      { file: 'Cinzel-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'Cinzel-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['cinzel'],
  },
  {
    family: 'Montserrat',
    files: [
      { file: 'Montserrat-Regular.ttf', mime: 'font/truetype', weight: '100 400' },
      { file: 'Montserrat-SemiBold.ttf', mime: 'font/truetype', weight: '500 600' },
      { file: 'Montserrat-Bold.ttf', mime: 'font/truetype', weight: '700 900' },
    ],
    aliases: ['montserrat'],
  },
  {
    family: 'Playfair Display',
    files: [
      { file: 'PlayfairDisplay-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'PlayfairDisplay-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['playfair display', 'playfairdisplay'],
  },
  {
    family: 'Cormorant Garamond',
    files: [
      { file: 'CormorantGaramond-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'CormorantGaramond-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['cormorant garamond', 'cormorantgaramond'],
  },
  {
    family: 'EB Garamond',
    files: [
      { file: 'EBGaramond-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'EBGaramond-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['eb garamond', 'ebgaramond'],
  },
  {
    family: 'Lora',
    files: [
      { file: 'Lora-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'Lora-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['lora'],
  },
  {
    family: 'Raleway',
    files: [
      { file: 'Raleway-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'Raleway-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['raleway'],
  },
  {
    family: 'Inter',
    files: [
      { file: 'Inter-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'Inter-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['inter'],
  },
  {
    family: 'Noto Sans Devanagari',
    files: [
      { file: 'NotoSansDevanagari-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSansDevanagari-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans devanagari', 'devanagari'],
  },
  {
    family: 'Noto Serif Devanagari',
    files: [
      { file: 'NotoSerif-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSerif-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto serif devanagari', 'noto serif'],
  },
  {
    family: 'Noto Sans Gujarati',
    files: [
      { file: 'MuktaVaani-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'MuktaVaani-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans gujarati', 'mukta vaani', 'muktavaani', 'gujarati'],
  },
  {
    family: 'Noto Sans Bengali',
    files: [
      { file: 'NotoSansBengali-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSansBengali-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans bengali', 'bengali'],
  },
  {
    family: 'Noto Sans Kannada',
    files: [
      { file: 'NotoSansKannada-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSansKannada-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans kannada', 'kannada'],
  },
  {
    family: 'Noto Sans Telugu',
    files: [
      { file: 'NotoSansTelugu-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSansTelugu-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans telugu', 'telugu'],
  },
  {
    family: 'Noto Sans Tamil',
    files: [
      { file: 'NotoSansTamil-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'NotoSansTamil-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['noto sans tamil', 'tamil'],
  },
  {
    family: 'Mukta Mahee',
    files: [
      { file: 'MuktaMahee-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'MuktaMahee-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['mukta mahee', 'muktamahee', 'noto sans gurmukhi', 'gurmukhi', 'punjabi'],
  },
  {
    family: 'Amiri',
    files: [
      { file: 'Amiri-Regular.ttf', mime: 'font/truetype', weight: '100 500' },
      { file: 'Amiri-Bold.ttf', mime: 'font/truetype', weight: '600 900' },
    ],
    aliases: ['amiri', 'noto sans arabic', 'arabic', 'urdu'],
  },
  {
    family: 'Rozha One',
    files: [{ file: 'NotoSansDevanagari-Bold.ttf', mime: 'font/truetype', weight: '100 900' }],
    aliases: ['rozha one', 'rozhaone'],
  },
  {
    family: 'Yatra One',
    files: [{ file: 'NotoSansDevanagari-Bold.ttf', mime: 'font/truetype', weight: '100 900' }],
    aliases: ['yatra one', 'yatraone'],
  },
  {
    family: 'Tillana',
    files: [{ file: 'NotoSansDevanagari-Regular.ttf', mime: 'font/truetype', weight: '400' }],
    aliases: ['tillana'],
  },
];

export function generateInlinedFontCss(html = '') {
  let css = '';
  const lower = (html || '').toLowerCase();

  for (const def of FONT_MAP) {
    const isMatched =
      def.family === 'Poppins' ||
      def.aliases.some((alias) => lower.includes(alias));

    if (!isMatched) continue;

    for (const f of def.files) {
      let dataUrl = getFontDataUrl(f.file, f.mime);
      if (!dataUrl && f.fallback) {
        dataUrl = getFontDataUrl(f.fallback, 'font/truetype');
      }
      if (dataUrl) {
        css += `@font-face { font-family: '${def.family}'; src: url('${dataUrl}') format('${f.mime === 'font/woff2' ? 'woff2' : 'truetype'}'); font-weight: ${f.weight}; font-style: normal; font-display: block; }\n`;
      }
    }
  }

  return css;
}

// ─── HTML Normalization & CSS Guarantees ───────────────────────────────────────
const GUARANTEE_CSS = `
  *, ::before, ::after {
    box-sizing: border-box;
    font-synthesis: weight style !important;
  }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: 210mm !important;
    height: 297mm !important;
    background: white !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    font-synthesis: weight style !important;
  }
  /* Script & Calligraphy font boldness parity for vector PDF */
  [style*="Great Vibes" i], [style*="Alex Brush" i], [style*="Sacramento" i],
  [style*="Allura" i], [style*="Parisienne" i], [style*="Cookie" i],
  [style*="Dancing Script" i], [style*="Satisfy" i], [style*="Tangerine" i] {
    font-synthesis: weight style !important;
    -webkit-text-stroke-width: 0.45px !important;
    paint-order: stroke fill !important;
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
  // In Chromium/Puppeteer, <base href="..."> breaks SVG fragment references like fill="url(#titleGrad)",
  // turning them into external HTTP requests which fail or abort, causing blank text.
  // Converting all URLs to absolute and stripping <base> allows SVG vector text to resolve in-document without hairlines.
  const baseMatch = normalizedHtml.match(/<base\s+[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (baseMatch) {
    const baseHref = baseMatch[1].replace(/\/+$/, '');
    normalizedHtml = normalizedHtml
      .replace(/(src|href)=(["']|&quot;)\/(?!\/)(.*?)\2/gi, `$1=$2${baseHref}/$3$2`)
      .replace(/url\(\s*(&quot;|['"]?)\/(?!\/)(.*?)\1\s*\)/gi, `url($1${baseHref}/$2$1)`)
      .replace(/<base\s+[^>]*>/gi, '');
  }

  // 1. Sanitize &quot; inside inline style attributes so SVG and CSS rules are not corrupted
  normalizedHtml = normalizedHtml.replace(/&quot;/g, "'");

  // 2. Strip external Google Fonts, preconnects, and Astro website bundles.
  // All fonts are inlined as Base64 data: URIs and all layout styling is in GUARANTEE_CSS.
  // Stripping these prevents Chromium from making 10-15 outbound network calls to Google Fonts/Cloudflare,
  // cutting PDF render time from 10+ seconds down to ~2 seconds!
  normalizedHtml = normalizedHtml
    .replace(/<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com|_astro)[^>]*>/gi, '')
    .replace(/<link[^>]+rel=["']preconnect["'][^>]*>/gi, '');

  const inlinedFontCss = generateInlinedFontCss(normalizedHtml);

  if (normalizedHtml.includes('</head>')) {
    normalizedHtml = normalizedHtml.replace('</head>', `<style>${inlinedFontCss}\n${GUARANTEE_CSS}</style></head>`);
  } else {
    normalizedHtml = `<style>${inlinedFontCss}\n${GUARANTEE_CSS}</style>` + normalizedHtml;
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
    const pageSetup = await acquirePage();
    browser = pageSetup.browser;
    context = pageSetup.context;
    page = pageSetup.page;

    const tContent0 = Date.now();
    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const contentMs = Date.now() - tContent0;

    const tWait0 = Date.now();
    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 60)); // Settle after background propagation
    const waitMs = Date.now() - tWait0;

    const tPdf0 = Date.now();
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    const pdfMs = Date.now() - tPdf0;

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Vector PDF created: ${pdfBuffer.length} bytes in ${totalTimeMs}ms (content: ${contentMs}ms, assets: ${waitMs}ms, pdf: ${pdfMs}ms, queue: ${queueWaitMs}ms)`
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
    const pageSetup = await acquirePage();
    browser = pageSetup.browser;
    context = pageSetup.context;
    page = pageSetup.page;

    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 60)); // Settle after background propagation

    // 1. True Vector PDF
    const tPdf0 = Date.now();
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    const pdfMs = Date.now() - tPdf0;

    // 2. High-res PNG (Single screenshot pass)
    const tPng0 = Date.now();
    const pngBuffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 794, height: 1123 },
    });
    const pngMs = Date.now() - tPng0;

    // 3. Ultra-fast native C++ Libvips JPEG generation (15ms vs 4000ms Chromium pass)
    const tJpeg0 = Date.now();
    const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 90, mozjpeg: false }).toBuffer();
    const jpegMs = Date.now() - tJpeg0;

    // 4. Package into valid .zip with JSZip using STORE (prevents CPU thrash on already-compressed media)
    const tZip0 = Date.now();
    const zip = new JSZip();
    zip.file(`${cleanName}.pdf`, pdfBuffer);
    zip.file(`${cleanName}.png`, pngBuffer);
    zip.file(`${cleanName}.jpg`, jpegBuffer);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    });
    const zipMs = Date.now() - tZip0;

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Combo ZIP created: ${zipBuffer.length} bytes in ${totalTimeMs}ms (pdf: ${pdfMs}ms, png: ${pngMs}ms, sharp-jpeg: ${jpegMs}ms, zip: ${zipMs}ms, queue: ${queueWaitMs}ms)`
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
  await acquireSlot(1);
  const queueWaitMs = Date.now() - queueStart;

  const renderStart = Date.now();
  let browser = null;
  let context = null;
  let page = null;

  try {
    const pageSetup = await acquirePage();
    browser = pageSetup.browser;
    context = pageSetup.context;
    page = pageSetup.page;

    const isJpeg = format.toLowerCase() === 'jpg' || format.toLowerCase() === 'jpeg';
    const pagesCount = Math.max(1, Number(totalPages) || 1);

    const tContent0 = Date.now();
    const normalizedHtml = prepareNormalizedHtml(fullHtml);
    await page.setContent(normalizedHtml, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const contentMs = Date.now() - tContent0;

    const tWait0 = Date.now();
    await waitForAssets(page);
    await propagateTemplateBackground(page);
    await new Promise((r) => setTimeout(r, 50)); // Settle after background propagation
    const waitMs = Date.now() - tWait0;

    // Multi-page bundle as ZIP: captures one A4 page at a time with instant hardware clip
    if (pagesCount > 1 && bundleZip) {
      const zip = new JSZip();
      const ext = isJpeg ? 'jpg' : 'png';
      const screenshotType = isJpeg ? 'jpeg' : 'png';

      for (let i = 0; i < pagesCount; i++) {
        const pageBuf = await page.screenshot({
          type: screenshotType,
          ...(isJpeg ? { quality: 90 } : {}),
          optimizeForSpeed: true,
          clip: { x: 0, y: i * 1123, width: 794, height: 1123 },
        });
        zip.file(`${cleanName}_Page_${i + 1}.${ext}`, pageBuf);
      }

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'STORE',
      });
      const totalTimeMs = Date.now() - renderStart;
      console.log(
        `[PDF Generator] Multi-page Image ZIP created (${pagesCount} pages): ${zipBuffer.length} bytes in ${totalTimeMs}ms (content: ${contentMs}ms, assets: ${waitMs}ms, queue: ${queueWaitMs}ms)`
      );
      return { isZip: true, buffer: zipBuffer };
    }

    // Single page capture: hardware Skia clip directly in requested format with optimizeForSpeed
    const safePageIndex = Math.max(0, Number(pageIndex) || 0);
    const clipY = safePageIndex * 1123;
    const tShot0 = Date.now();
    const imgBuffer = await page.screenshot({
      type: isJpeg ? 'jpeg' : 'png',
      ...(isJpeg ? { quality: 90 } : {}),
      optimizeForSpeed: true,
      clip: { x: 0, y: clipY, width: 794, height: 1123 },
    });
    const shotMs = Date.now() - tShot0;

    const totalTimeMs = Date.now() - renderStart;
    console.log(
      `[PDF Generator] Image (${format.toUpperCase()}) created: ${imgBuffer.length} bytes in ${totalTimeMs}ms (content: ${contentMs}ms, assets: ${waitMs}ms, screenshot: ${shotMs}ms, queue: ${queueWaitMs}ms)`
    );

    return { isZip: false, buffer: imgBuffer };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    releaseSlot(1);
  }
}


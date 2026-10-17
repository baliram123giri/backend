import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ROOT = path.resolve(__dirname, '../../../client');
const TEMPLATES_JSON_PATH = path.join(CLIENT_ROOT, 'src/data/templatesData.json');

const PUBLIC_FRAMES = path.join(CLIENT_ROOT, 'public/frames');
const PUBLIC_THUMBNAILS = path.join(CLIENT_ROOT, 'public/thumbnails');
const PUBLIC_STICKERS = path.join(CLIENT_ROOT, 'public/stickers');
const DIST_FRAMES = path.join(CLIENT_ROOT, 'dist/client/frames');
const DIST_THUMBNAILS = path.join(CLIENT_ROOT, 'dist/client/thumbnails');
const DIST_STICKERS = path.join(CLIENT_ROOT, 'dist/client/stickers');

const API_URL = 'https://api.biodata99.com/api/templates?limit=100';

function ensureDirs() {
  [PUBLIC_FRAMES, PUBLIC_THUMBNAILS, PUBLIC_STICKERS, DIST_FRAMES, DIST_THUMBNAILS, DIST_STICKERS].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function extractFilename(url) {
  if (!url) return '';
  const clean = url.split('?')[0].split('#')[0];
  return path.basename(clean);
}

async function downloadAndCompressFrame(remoteUrl) {
  if (!remoteUrl || !remoteUrl.startsWith('http')) return remoteUrl;
  const filename = extractFilename(remoteUrl);
  if (!filename) return remoteUrl;

  const pubTarget = path.join(PUBLIC_FRAMES, filename);
  const distTarget = path.join(DIST_FRAMES, filename);

  console.log(`Downloading frame: ${filename} from ${remoteUrl}...`);
  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch frame ${remoteUrl}: HTTP ${res.status}`);
  }
  const rawBuffer = Buffer.from(await res.arrayBuffer());

  let processedBuffer;
  try {
    const meta = await sharp(rawBuffer).metadata();
    if (meta.format === 'svg') {
      processedBuffer = rawBuffer;
    } else {
      let pipeline = sharp(rawBuffer);
      if ((meta.width && meta.width > 1200) || (meta.height && meta.height > 1600)) {
        pipeline = pipeline.resize({ width: 1055, height: 1492, fit: 'inside', withoutEnlargement: true });
      }
      processedBuffer = await pipeline.webp({ quality: 80, effort: 4 }).toBuffer();
    }
  } catch (err) {
    console.warn(`Sharp processing warning for frame ${filename}, saving raw:`, err.message);
    processedBuffer = rawBuffer;
  }

  fs.writeFileSync(pubTarget, processedBuffer);
  if (fs.existsSync(path.dirname(distTarget))) {
    fs.writeFileSync(distTarget, processedBuffer);
  }

  console.log(`✓ Saved frame: ${filename} (${processedBuffer.length} bytes, was ${rawBuffer.length} bytes)`);
  return `/frames/${filename}`;
}

async function downloadAndCompressThumbnail(remoteUrl) {
  if (!remoteUrl || !remoteUrl.startsWith('http')) return remoteUrl;
  const filename = extractFilename(remoteUrl);
  if (!filename) return remoteUrl;

  const pubTarget = path.join(PUBLIC_THUMBNAILS, filename);
  const distTarget = path.join(DIST_THUMBNAILS, filename);

  console.log(`Downloading thumbnail: ${filename} from ${remoteUrl}...`);
  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch thumbnail ${remoteUrl}: HTTP ${res.status}`);
  }
  const rawBuffer = Buffer.from(await res.arrayBuffer());

  let processedBuffer;
  try {
    processedBuffer = await sharp(rawBuffer)
      .resize({ width: 600, height: 849, fit: 'cover' })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
  } catch (err) {
    console.warn(`Sharp processing warning for thumbnail ${filename}, saving raw:`, err.message);
    processedBuffer = rawBuffer;
  }

  fs.writeFileSync(pubTarget, processedBuffer);
  if (fs.existsSync(path.dirname(distTarget))) {
    fs.writeFileSync(distTarget, processedBuffer);
  }

  console.log(`✓ Saved thumbnail: ${filename} (${processedBuffer.length} bytes, was ${rawBuffer.length} bytes)`);
  return `/thumbnails/${filename}`;
}

async function downloadAndCompressSticker(remoteUrl) {
  if (!remoteUrl || !remoteUrl.startsWith('http')) return remoteUrl;
  const filename = extractFilename(remoteUrl);
  if (!filename) return remoteUrl;

  const pubTarget = path.join(PUBLIC_STICKERS, filename);
  const distTarget = path.join(DIST_STICKERS, filename);

  if (fs.existsSync(pubTarget) && fs.statSync(pubTarget).size > 500) {
    return `/stickers/${filename}`;
  }

  console.log(`Downloading sticker: ${filename} from ${remoteUrl}...`);
  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch sticker ${remoteUrl}: HTTP ${res.status}`);
  }
  const rawBuffer = Buffer.from(await res.arrayBuffer());

  let processedBuffer;
  try {
    const meta = await sharp(rawBuffer).metadata();
    if (meta.format === 'svg') {
      processedBuffer = rawBuffer;
    } else {
      processedBuffer = await sharp(rawBuffer)
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, effort: 4, alphaQuality: 90 })
        .toBuffer();
    }
  } catch (err) {
    console.warn(`Sharp processing warning for sticker ${filename}, saving raw:`, err.message);
    processedBuffer = rawBuffer;
  }

  fs.writeFileSync(pubTarget, processedBuffer);
  if (fs.existsSync(path.dirname(distTarget))) {
    fs.writeFileSync(distTarget, processedBuffer);
  }

  console.log(`✓ Saved sticker: ${filename} (${processedBuffer.length} bytes)`);
  return `/stickers/${filename}`;
}

async function run() {
  ensureDirs();

  console.log(`Reading local templates from: ${TEMPLATES_JSON_PATH}`);
  const existingTemplates = JSON.parse(fs.readFileSync(TEMPLATES_JSON_PATH, 'utf8'));
  const existingIds = new Set(existingTemplates.map(t => t.id));
  console.log(`Current existing templates in JSON: ${existingTemplates.length}`);

  console.log(`Fetching latest templates from backend API: ${API_URL}`);
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  const data = await res.json();
  const beTemplates = data.templates || data;
  console.log(`Total templates received from BE: ${beTemplates.length}`);

  // Find newly added templates not already in local JSON
  const newTemplates = beTemplates.filter(t => !existingIds.has(t.id));
  console.log(`Found ${newTemplates.length} new templates not in local JSON.`);

  // Filter only those created for Muslims / Islamic / Urdu
  const muslimNewTemplates = newTemplates.filter(t => {
    const rel = (t.religion || '').toLowerCase();
    const name = (t.name || '').toLowerCase();
    return (
      rel === 'muslim' ||
      rel === 'islam' ||
      name.includes('muslim') ||
      name.includes('islamic') ||
      name.includes('nikah') ||
      name.includes('mosque') ||
      name.includes('urdu')
    );
  });

  console.log(`\nFound ${muslimNewTemplates.length} new Muslim templates to process:`);
  muslimNewTemplates.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.id}] "${t.name}" (religion: ${t.religion})`);
  });

  if (muslimNewTemplates.length === 0) {
    console.log('No new Muslim templates to add. Everything is up to date.');
    return;
  }

  const processedNewTemplates = [];

  for (const tpl of muslimNewTemplates) {
    console.log(`\n--- Processing template: "${tpl.name}" (${tpl.id}) ---`);
    const cloned = JSON.parse(JSON.stringify(tpl));

    // 1. Process frame urlTemplate
    if (cloned.frame && cloned.frame.urlTemplate) {
      cloned.frame.urlTemplate = await downloadAndCompressFrame(cloned.frame.urlTemplate);
    }

    // 2. Process page2UrlTemplate if present
    if (cloned.frame && cloned.frame.page2UrlTemplate) {
      cloned.frame.page2UrlTemplate = await downloadAndCompressFrame(cloned.frame.page2UrlTemplate);
    }
    if (cloned.page2FrameUrlTemplate) {
      cloned.page2FrameUrlTemplate = await downloadAndCompressFrame(cloned.page2FrameUrlTemplate);
    }

    // 3. Process thumbnail
    if (cloned.thumbnailUrl) {
      cloned.thumbnailUrl = await downloadAndCompressThumbnail(cloned.thumbnailUrl);
    }

    // 4. Ensure local sticker reference
    if (cloned.bgConfig && cloned.bgConfig.mantraSignUrl) {
      cloned.bgConfig.mantraSignUrl = await downloadAndCompressSticker(cloned.bgConfig.mantraSignUrl);
    }

    // Set defaults if needed
    cloned.religion = cloned.religion || 'Muslim';
    if (!cloned.defaultAccent || cloned.defaultAccent === '#C9A84C') {
      cloned.defaultAccent = cloned.defaultPrimary || '#597155';
    }

    // 5. Ensure sectionStyles has matching __global__ colors
    if (!cloned.bgConfig) cloned.bgConfig = {};
    let bgSs = {};
    try {
      bgSs = typeof cloned.bgConfig.sectionStyles === 'string' ? JSON.parse(cloned.bgConfig.sectionStyles || '{}') : (cloned.bgConfig.sectionStyles || {});
    } catch {}
    if (!bgSs.__global__) {
      bgSs.__global__ = {
        headingShapeColorType: "solid",
        headingShapeColor: cloned.defaultPrimary || '#597155',
        headingTextColor: cloned.defaultPrimary || '#597155',
        headerTextColor: cloned.defaultPrimary || '#597155',
        detailsTextColor: cloned.defaultSecondary || '#333333'
      };
      cloned.bgConfig.sectionStyles = JSON.stringify(bgSs);
    }

    processedNewTemplates.push(cloned);
  }

  // Prepend newly created templates to the top of the array
  const updatedTemplates = [...processedNewTemplates, ...existingTemplates];

  console.log(`\nWriting updated templates list to ${TEMPLATES_JSON_PATH}`);
  fs.writeFileSync(TEMPLATES_JSON_PATH, JSON.stringify(updatedTemplates, null, 2), 'utf-8');
  console.log(`✓ Successfully updated templatesData.json. Total templates now: ${updatedTemplates.length}`);
}

run().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});

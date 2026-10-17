import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_PUBLIC_DIR = path.resolve(__dirname, '../../../client/public');
const FRAMES_DIR = path.join(CLIENT_PUBLIC_DIR, 'frames');
const THUMBNAILS_DIR = path.join(CLIENT_PUBLIC_DIR, 'thumbnails');
const STICKERS_DIR = path.join(CLIENT_PUBLIC_DIR, 'stickers');
const TEMPLATES_JSON_PATH = path.resolve(__dirname, '../../../client/src/data/templatesData.json');

// Ensure destination directories exist
fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
fs.mkdirSync(STICKERS_DIR, { recursive: true });

async function downloadBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Download] Failed HTTP ${res.status} for ${url}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(`[Download] Error fetching ${url}:`, err.message);
    return null;
  }
}

async function processImage(rawUrl, category) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('<svg') || trimmed.startsWith('data:')) return trimmed;
  if (trimmed.startsWith('/website/')) return trimmed; // Website assets remain unchanged

  let targetDir, urlPrefix;
  if (category === 'frame') {
    targetDir = FRAMES_DIR;
    urlPrefix = '/frames';
  } else if (category === 'thumbnail') {
    targetDir = THUMBNAILS_DIR;
    urlPrefix = '/thumbnails';
  } else if (category === 'sticker') {
    targetDir = STICKERS_DIR;
    urlPrefix = '/stickers';
  } else {
    return trimmed;
  }

  // Extract clean filename
  const filename = path.basename(trimmed.split('?')[0]);
  if (!filename) return trimmed;

  const targetPath = path.join(targetDir, filename);

  // If file already exists locally, check if we need to optimize it
  let buffer = null;
  if (fs.existsSync(targetPath)) {
    buffer = fs.readFileSync(targetPath);
  } else {
    // Determine download URL
    let downloadUrl = trimmed;
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
      downloadUrl = `https://img.biodata99.com/biodata${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`;
    }

    console.log(`[Download] Fetching ${category}: ${downloadUrl}`);
    buffer = await downloadBuffer(downloadUrl);

    if (!buffer && downloadUrl.includes('/biodata/')) {
      // Try alternate matrimonial folder path fallback if any
      const altUrl = downloadUrl.replace('/biodata/', '/matrimonial/');
      buffer = await downloadBuffer(altUrl);
    }
  }

  if (!buffer || buffer.length === 0) {
    console.warn(`[Warning] Could not obtain image for ${trimmed}`);
    return trimmed.startsWith('http') ? trimmed : `${urlPrefix}/${filename}`;
  }

  // If SVG format, write as-is
  const isSvg = filename.endsWith('.svg') || (buffer[0] === 0x3c);
  if (isSvg) {
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, buffer);
      console.log(`[Save] SVG saved: ${filename} (${buffer.length} bytes)`);
    }
    return `${urlPrefix}/${filename}`;
  }

  // Compress raster image using Sharp
  try {
    let compressed;
    if (category === 'thumbnail') {
      // Reference: 600 x 849, WebP, quality 78 (~30KB-40KB)
      compressed = await sharp(buffer)
        .resize(600, 849, { fit: 'fill' })
        .webp({ quality: 78, effort: 6 })
        .toBuffer();
    } else if (category === 'frame') {
      // Reference: 1054 x 1492, WebP, quality 80 (~30KB-80KB)
      const meta = await sharp(buffer).metadata();
      let pipeline = sharp(buffer);
      if (meta.width !== 1054 || meta.height !== 1492) {
        pipeline = pipeline.resize(1054, 1492, { fit: 'fill' });
      }
      compressed = await pipeline
        .webp({ quality: 80, effort: 6 })
        .toBuffer();
    } else if (category === 'sticker') {
      // Reference: max 400x400 with alpha, WebP, quality 85 (~10KB-40KB)
      const meta = await sharp(buffer).metadata();
      let pipeline = sharp(buffer);
      if (meta.width > 400 || meta.height > 400) {
        pipeline = pipeline.resize(400, 400, { fit: 'inside', withoutEnlargement: true });
      }
      compressed = await pipeline
        .webp({ quality: 85, alphaQuality: 90, effort: 6 })
        .toBuffer();
    }

    if (compressed) {
      fs.writeFileSync(targetPath, compressed);
      console.log(`[Compressed] ${category}: ${filename} (${buffer.length} -> ${compressed.length} bytes)`);
    }
  } catch (sharpErr) {
    console.warn(`[Sharp Error] ${filename}:`, sharpErr.message);
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, buffer);
    }
  }

  return `${urlPrefix}/${filename}`;
}

export async function runSyncTemplates() {
  console.log('=== Starting Template Sync & Image Compression ===');
  
  // 1. Fetch latest templates from BE API
  console.log('Fetching latest templates from backend API...');
  let templates = [];
  try {
    const res = await fetch('https://api.biodata99.com/api/templates?limit=100');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    templates = data.templates || [];
    console.log(`Fetched ${templates.length} templates from BE.`);
  } catch (err) {
    console.error('Failed to fetch from live API:', err.message);
    throw err;
  }

  if (!templates.length) {
    throw new Error('No templates received.');
  }

  // 2. Process each template
  const processed = [];
  for (let i = 0; i < templates.length; i++) {
    const tpl = { ...templates[i] };
    console.log(`[${i + 1}/${templates.length}] Processing template: ${tpl.name || tpl.id}`);

    // Process frame url
    if (tpl.frame && tpl.frame.urlTemplate) {
      tpl.frame.urlTemplate = await processImage(tpl.frame.urlTemplate, 'frame');
    }
    // Process page2 frame url
    if (tpl.frame && tpl.frame.page2UrlTemplate) {
      tpl.frame.page2UrlTemplate = await processImage(tpl.frame.page2UrlTemplate, 'frame');
    }
    if (tpl.page2FrameUrlTemplate) {
      tpl.page2FrameUrlTemplate = await processImage(tpl.page2FrameUrlTemplate, 'frame');
    }
    // Process thumbnail url
    if (tpl.thumbnailUrl) {
      tpl.thumbnailUrl = await processImage(tpl.thumbnailUrl, 'thumbnail');
    }
    // Process mantra sticker url
    if (tpl.bgConfig && tpl.bgConfig.mantraSignUrl) {
      tpl.bgConfig.mantraSignUrl = await processImage(tpl.bgConfig.mantraSignUrl, 'sticker');
    }

    processed.push(tpl);
  }

  // 3. Write to client/src/data/templatesData.json
  console.log(`Saving ${processed.length} templates to ${TEMPLATES_JSON_PATH}...`);
  fs.writeFileSync(TEMPLATES_JSON_PATH, JSON.stringify(processed, null, 2), 'utf-8');
  console.log('=== Templates Sync & Compression Complete Successfully ===');

  return { total: processed.length, templatesCount: processed.length };
}

if (process.argv[1] && process.argv[1].endsWith('sync-and-compress-templates.js')) {
  runSyncTemplates().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}


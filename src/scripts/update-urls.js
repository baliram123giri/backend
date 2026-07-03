import { prisma } from '../lib/prisma.js';

async function main() {
  try {
    // 1. Update Stickers
    const stickers = await prisma.sticker.findMany();
    let stickerCount = 0;
    for (const sticker of stickers) {
      if (sticker.url && sticker.url.includes("https://img.biodata99.com/matrimonial/")) {
        const newUrl = sticker.url.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
        await prisma.sticker.update({
          where: { id: sticker.id },
          data: { url: newUrl }
        });
        stickerCount++;
      }
    }
    // 2. Update Backgrounds
    const backgrounds = await prisma.background.findMany();
    let backgroundCount = 0;
    for (const bg of backgrounds) {
      if (bg.url && bg.url.includes("https://img.biodata99.com/matrimonial/")) {
        const newUrl = bg.url.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
        await prisma.background.update({
          where: { id: bg.id },
          data: { url: newUrl }
        });
        backgroundCount++;
      }
    }

    // 3. Update Templates
    const templates = await prisma.template.findMany();
    let templateCount = 0;
    for (const tpl of templates) {
      let needsUpdate = false;
      const updateData = {};

      if (tpl.frameUrlTemplate && tpl.frameUrlTemplate.includes("https://img.biodata99.com/matrimonial/")) {
        updateData.frameUrlTemplate = tpl.frameUrlTemplate.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
        needsUpdate = true;
      }

      if (tpl.thumbnailUrl && tpl.thumbnailUrl.includes("https://img.biodata99.com/matrimonial/")) {
        updateData.thumbnailUrl = tpl.thumbnailUrl.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
        needsUpdate = true;
      }

      if (tpl.previewPhotoUrl && tpl.previewPhotoUrl.includes("https://img.biodata99.com/matrimonial/")) {
        updateData.previewPhotoUrl = tpl.previewPhotoUrl.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
        needsUpdate = true;
      }

      if (tpl.bgConfig) {
        let bgConfig = typeof tpl.bgConfig === 'string' ? JSON.parse(tpl.bgConfig) : { ...tpl.bgConfig };
        let bgConfigChanged = false;

        if (bgConfig.url && bgConfig.url.includes("https://img.biodata99.com/matrimonial/")) {
          bgConfig.url = bgConfig.url.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
          bgConfigChanged = true;
        }

        if (bgConfig.mantraSignUrl && bgConfig.mantraSignUrl.includes("https://img.biodata99.com/matrimonial/")) {
          bgConfig.mantraSignUrl = bgConfig.mantraSignUrl.replace("https://img.biodata99.com/matrimonial/", "https://img.biodata99.com/biodata/");
          bgConfigChanged = true;
        }

        if (bgConfigChanged) {
          updateData.bgConfig = bgConfig;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        await prisma.template.update({
          where: { id: tpl.id },
          data: updateData
        });
        templateCount++;
      }
    }
    console.log(`Updated ${templateCount} templates.`);
    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

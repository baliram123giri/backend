import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const templatesJsonPath = path.resolve(__dirname, '../../../client/src/data/templatesData.json');

async function syncTemplatesPadding() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('Connecting to database...');
    // 1. Ensure page2PaddingTop column exists
    console.log('Ensuring page2PaddingTop column exists in "Template" table...');
    await pool.query(`ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "page2PaddingTop" INTEGER;`);
    console.log('Column verified.');

    // 2. Read templatesData.json
    console.log(`Reading templates from ${templatesJsonPath}...`);
    const rawData = fs.readFileSync(templatesJsonPath, 'utf8');
    const templates = JSON.parse(rawData);
    console.log(`Loaded ${templates.length} templates from JSON.`);

    let updatedCount = 0;
    let notFoundCount = 0;

    for (const tpl of templates) {
      if (!tpl.id) continue;

      const padding = typeof tpl.defaultPadding === 'number' ? tpl.defaultPadding : 60;
      const yPadding = typeof tpl.defaultYPadding === 'number' ? tpl.defaultYPadding : null;
      const paddingTop = typeof tpl.defaultPaddingTop === 'number' ? tpl.defaultPaddingTop : null;
      const paddingRight = typeof tpl.defaultPaddingRight === 'number' ? tpl.defaultPaddingRight : null;
      const paddingLeft = typeof tpl.defaultPaddingLeft === 'number' ? tpl.defaultPaddingLeft : null;
      const page2PaddingTop = typeof tpl.page2PaddingTop === 'number' ? tpl.page2PaddingTop : null;

      const photoX = tpl.photo && typeof tpl.photo.x === 'number' ? tpl.photo.x : 390;
      const photoY = tpl.photo && typeof tpl.photo.y === 'number' ? tpl.photo.y : 100;
      const photoW = tpl.photo && typeof tpl.photo.width === 'number' ? tpl.photo.width : 100;
      const photoH = tpl.photo && typeof tpl.photo.height === 'number' ? tpl.photo.height : 130;
      const photoRadius = tpl.photo && typeof tpl.photo.cornerRadius === 'number' ? tpl.photo.cornerRadius : 8;
      const photoBorder = tpl.photo ? (tpl.photo.showBorder !== false) : true;

      const updateQuery = `
        UPDATE "Template"
        SET 
          "defaultPadding" = $1,
          "defaultYPadding" = $2,
          "defaultPaddingTop" = $3,
          "defaultPaddingRight" = $4,
          "defaultPaddingLeft" = $5,
          "page2PaddingTop" = $6,
          "photoX" = $7,
          "photoY" = $8,
          "photoWidth" = $9,
          "photoHeight" = $10,
          "photoCornerRadius" = $11,
          "photoShowBorder" = $12
        WHERE "id" = $13
      `;

      const res = await pool.query(updateQuery, [
        padding,
        yPadding,
        paddingTop,
        paddingRight,
        paddingLeft,
        page2PaddingTop,
        photoX,
        photoY,
        photoW,
        photoH,
        photoRadius,
        photoBorder,
        tpl.id
      ]);

      if (res.rowCount > 0) {
        updatedCount++;
      } else {
        notFoundCount++;
      }
    }

    console.log(`\nSync Complete!`);
    console.log(`Successfully updated in DB: ${updatedCount} templates.`);
    if (notFoundCount > 0) {
      console.log(`Templates not found in DB: ${notFoundCount}`);
    }
  } catch (error) {
    console.error('Error during synchronization:', error);
  } finally {
    await pool.end();
  }
}

syncTemplatesPadding();

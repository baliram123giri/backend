import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const templatesJsonPath = path.resolve(__dirname, '../../../client/src/data/templatesData.json');

async function syncTemplatesRawInput() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('Connecting to database...');
    const rawData = fs.readFileSync(templatesJsonPath, 'utf8');
    const templates = JSON.parse(rawData);
    console.log(`Loaded ${templates.length} templates from JSON.`);

    let updatedCount = 0;
    for (const tpl of templates) {
      if (!tpl.id || !tpl.rawInput) continue;

      const updateQuery = `
        UPDATE "Template"
        SET "rawInput" = $1
        WHERE "id" = $2;
      `;
      const res = await pool.query(updateQuery, [JSON.stringify(tpl.rawInput), tpl.id]);
      if (res.rowCount > 0) {
        updatedCount++;
      }
    }

    console.log(`Successfully synced rawInput for ${updatedCount} templates in database.`);
  } catch (err) {
    console.error('Error syncing rawInput:', err.message);
  } finally {
    await pool.end();
  }
}

syncTemplatesRawInput();

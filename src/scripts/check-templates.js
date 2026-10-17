import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ROOT = path.resolve(__dirname, '../../../client');
const TEMPLATES_JSON_PATH = path.join(CLIENT_ROOT, 'src/data/templatesData.json');
const API_URL = 'https://api.biodata99.com/api/templates?limit=100';

async function check() {
  const existingTemplates = JSON.parse(fs.readFileSync(TEMPLATES_JSON_PATH, 'utf8'));
  const existingIds = new Set(existingTemplates.map(t => t.id));
  console.log(`Existing templates count in JSON: ${existingTemplates.length}`);

  const res = await fetch(API_URL);
  const data = await res.json();
  const beTemplates = data.templates || data;
  console.log(`BE templates count: ${beTemplates.length}`);

  const newTemplates = beTemplates.filter(t => !existingIds.has(t.id));
  console.log(`\nNew templates not in local JSON (${newTemplates.length}):`);
  newTemplates.forEach((t, i) => {
    console.log(`${i + 1}. [${t.id}] "${t.name}" (religion: ${t.religion}, lang: ${t.language})`);
  });

  const muslimTemplates = beTemplates.filter(t => 
    (t.religion || '').toLowerCase().includes('muslim') || 
    (t.name || '').toLowerCase().includes('muslim') || 
    (t.name || '').toLowerCase().includes('islamic') || 
    (t.name || '').toLowerCase().includes('nikah') ||
    (t.name || '').toLowerCase().includes('mosque')
  ).slice(0, 5);

  console.log(`\n--- Top 5 Muslim Templates from BE API ---`);
  muslimTemplates.forEach((t, i) => {
    console.log(`\n[${i + 1}] ID: ${t.id} - "${t.name}"`);
    console.log(`  defaultPrimary: ${t.defaultPrimary}`);
    console.log(`  defaultSecondary: ${t.defaultSecondary}`);
    console.log(`  defaultAccent: ${t.defaultAccent}`);
    console.log(`  sectionHeadingShape: ${t.sectionHeadingShape}`);
    console.log(`  titleShape: ${t.titleShape}`);
    console.log(`  bgConfig.sectionStyles:`, t.bgConfig?.sectionStyles);
    console.log(`  bgConfig.sectionHeadingShape:`, t.bgConfig?.sectionHeadingShape);
  });
}

check().catch(console.error);

import { prisma } from '../lib/prisma.js';

async function main() {
  const updated = await prisma.$executeRaw`
    UPDATE "DownloadLog"
    SET "name" = TRIM("name")
    WHERE "name" != TRIM("name")
  `;
  console.log(`Trimmed ${updated} records in DownloadLog.`);
}

main().catch(console.error).finally(() => process.exit());

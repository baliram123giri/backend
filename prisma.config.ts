import 'dotenv/config';
import { defineConfig } from '@prisma/config';

export default defineConfig({
  datasource: {
    // Schema changes (prisma db push/migrate) need the owner user; the running app uses the
    // restricted DATABASE_URL. Falls back to DATABASE_URL when MIGRATE_DATABASE_URL is unset.
    url: process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL
  }
});

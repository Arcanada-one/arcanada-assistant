import path from 'node:path';
import { defineConfig } from '@prisma/config';

// Prisma 7+: DATABASE_URL lives here, not in schema.prisma datasource block.
// Per CLAUDE.md feedback `prisma7_config_url`. Env loaded by the host process
// (NestJS ConfigModule for runtime; CI env for migrations).
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});

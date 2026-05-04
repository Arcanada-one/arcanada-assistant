import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/tests/**',
        '**/index.ts',
        '**/main.ts',
        '**/*.module.ts',
        '**/prisma.config.ts',
        '**/telegram.gateway.ts',
      ],
    },
    include: ['**/*.{spec,test}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

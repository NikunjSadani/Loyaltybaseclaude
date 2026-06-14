import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Integration lane — live DB tests only (`*-live.test.ts`).
 *
 * These hit the real dev database (Cloud SQL `gifsy-db-dev` via the Auth Proxy on
 * 127.0.0.1:5433 — see docs/plans/DEV-DB.md). The proxy MUST be running and `.env`
 * must point at the dev DB. Run with: `npm run test:integration`.
 *
 * Kept out of the default `npm test` lane on purpose: the default suite is
 * deterministic (no real DB/network), per docs/plans/01-how-we-test.md.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*-live.test.ts'],
    // Load .env (DATABASE_URL etc.) before any test module imports the prisma singleton.
    setupFiles: ['./vitest.integration.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

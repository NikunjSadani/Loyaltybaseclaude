/// <reference types="vitest/globals" />
/**
 * The /api/* → backend rewrite is proxied by Next with a 30 s default limit (next/dist/server/lib/router-utils/
 * proxy-request.js: `proxyTimeout || 30000`). A slower request (the Bajaj sales-import apply, 2026-11-18) was cut off at
 * 30 s while the backend went on and finished it, so the page said "Nothing was applied" and admins applied again.
 * The limit must match Cloud Run's 300 s request timeout.
 * Run: npx vitest run src/__tests__/next-config-proxy-timeout.test.ts
 */
import { describe, it, expect } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config — proxy timeout', () => {
  it('sets experimental.proxyTimeout to 300 s (Cloud Run request timeout), not Next’s 30 s default', () => {
    expect(nextConfig.experimental?.proxyTimeout).toBe(300_000);
  });
});

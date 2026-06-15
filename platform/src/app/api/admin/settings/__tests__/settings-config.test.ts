/**
 * Wiring test: settings GET /api/admin/settings/config
 * Asserts the source text never exposes secret fields in the response.
 *
 * This is a source-read wiring test — it checks the file text, not runtime
 * behaviour. It runs without a real server or DB.
 *
 * Run: npx vitest run src/app/api/admin/settings/__tests__/settings-config.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROUTE_SRC = readFileSync(
  resolve(__dirname, '../config/route.ts'),
  'utf-8'
);

describe('settings GET /api/admin/settings/config — secret-leak guard', () => {
  it('source does NOT return msg91AuthKey in the response', () => {
    // The route must never surface msg91AuthKey. Look for any JSON inclusion.
    // We allow the name to appear as a comment or import, but not as a key
    // in a response object construction.
    const lines = ROUTE_SRC.split('\n');
    const suspiciousLines = lines.filter(
      (line) =>
        line.includes('msg91AuthKey') &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        // Allow usage in import types
        !line.includes('import ')
    );
    expect(suspiciousLines).toHaveLength(0);
  });

  it('source does NOT return bank account number in the response', () => {
    // bankAccountNumber is sensitive invoicing data — must not be returned
    const lines = ROUTE_SRC.split('\n');
    const suspiciousLines = lines.filter(
      (line) =>
        line.includes('bankAccountNumber') &&
        !line.trim().startsWith('//') &&
        !line.trim().startsWith('*') &&
        !line.includes('import ')
    );
    expect(suspiciousLines).toHaveLength(0);
  });

  it('source calls getTenantConfig for the config-specific GET handler', () => {
    expect(ROUTE_SRC).toContain('getTenantConfig');
  });

  it('source returns branding in the config response', () => {
    expect(ROUTE_SRC).toContain('branding');
  });

  it('source returns features in the config response', () => {
    expect(ROUTE_SRC).toContain('features');
  });
});

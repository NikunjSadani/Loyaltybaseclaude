/**
 * Tests for Task 1.4 — DB-backed tenant config loading.
 *
 * Covers:
 *  1. rowToClientConfig round-trip (pure, no I/O)
 *  2. getClientConfigFromDb behaviours (Prisma mocked)
 *  3. getTenantConfig fallback chain (Prisma + headers mocked)
 *
 * Run: npx vitest run src/lib/platform/__tests__/client-config-db.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist mock state so factory closures can reference it ───────────────────
// vi.mock factories are hoisted to the top of the file by Vitest; any
// variables they close over must also be hoisted via vi.hoisted().
const { mockPrismaClient, mockHeadersGet } = vi.hoisted(() => {
  const mockPrismaClient = {
    client: {
      findUnique: vi.fn(),
    },
  };
  const mockHeadersGet = vi.fn();
  return { mockPrismaClient, mockHeadersGet };
});

// Note: `server-only` is aliased to a no-op stub in vitest.config.ts — no
// explicit mock needed here.

// ─── Mock Prisma (both named + default export per the testing guide) ──────────
vi.mock('@/lib/prisma', () => ({
  default: mockPrismaClient,
  prisma: mockPrismaClient,
}));

// ─── Mock next/headers for getTenantConfig tests ──────────────────────────────
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve({ get: mockHeadersGet })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { rowToClientConfig } from '../client-row';
import { clientConfigToRow } from '../client-row';
import { DEOLEO_CONFIG, CLIENT_B_CONFIG } from '../client-registry';
import { getClientConfigFromDb } from '../client-config-db';
import { getTenantConfig } from '../server';

// ═════════════════════════════════════════════════════════════════════════════
// 1. rowToClientConfig — pure round-trip tests
// ═════════════════════════════════════════════════════════════════════════════

describe('rowToClientConfig — round-trip (DEOLEO_CONFIG)', () => {
  // Store the real auth key from the registry before any env-var tweaking
  const DEOLEO_AUTH_KEY = DEOLEO_CONFIG.notifications.msg91AuthKey;

  it('reconstructs an identical ClientConfig from its own row', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt).toEqual(DEOLEO_CONFIG);
  });

  it('re-attaches msg91AuthKey from the passed-in secret', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, 'MY_TEST_KEY');
    expect(rebuilt.notifications.msg91AuthKey).toBe('MY_TEST_KEY');
  });

  it('converts onboardedAt Date back to ISO date string', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(typeof rebuilt.onboardedAt).toBe('string');
    // Must match the original ISO date — e.g. "2025-01-01"
    expect(rebuilt.onboardedAt).toBe(DEOLEO_CONFIG.onboardedAt);
  });

  it('casts status back to the same literal', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.status).toBe('ACTIVE');
  });

  it('slug equals the row id', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.slug).toBe('deoleo');
  });

  it('branding block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.branding).toEqual(DEOLEO_CONFIG.branding);
  });

  it('features block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.features).toEqual(DEOLEO_CONFIG.features);
  });

  it('partnerClasses block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.partnerClasses).toEqual(DEOLEO_CONFIG.partnerClasses);
  });

  it('approvalHierarchy block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.approvalHierarchy).toEqual(DEOLEO_CONFIG.approvalHierarchy);
  });

  it('invoicing block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.invoicing).toEqual(DEOLEO_CONFIG.invoicing);
  });

  it('wallet block is identical', () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    const rebuilt = rowToClientConfig(row, DEOLEO_AUTH_KEY);
    expect(rebuilt.wallet).toEqual(DEOLEO_CONFIG.wallet);
  });
});

describe('rowToClientConfig — round-trip (CLIENT_B_CONFIG)', () => {
  const CLIENT_B_AUTH_KEY = CLIENT_B_CONFIG.notifications.msg91AuthKey;

  it('reconstructs an identical ClientConfig from its own row', () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    const rebuilt = rowToClientConfig(row, CLIENT_B_AUTH_KEY);
    expect(rebuilt).toEqual(CLIENT_B_CONFIG);
  });

  it('re-attaches msg91AuthKey from the passed-in secret', () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    const rebuilt = rowToClientConfig(row, 'B_REAL_KEY');
    expect(rebuilt.notifications.msg91AuthKey).toBe('B_REAL_KEY');
  });

  it('converts onboardedAt Date back to ISO date string', () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    const rebuilt = rowToClientConfig(row, CLIENT_B_AUTH_KEY);
    expect(rebuilt.onboardedAt).toBe(CLIENT_B_CONFIG.onboardedAt);
  });

  it('status ONBOARDING is preserved', () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    const rebuilt = rowToClientConfig(row, CLIENT_B_AUTH_KEY);
    expect(rebuilt.status).toBe('ONBOARDING');
  });

  it('wallet.pointsExpiryDays null is preserved', () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    const rebuilt = rowToClientConfig(row, CLIENT_B_AUTH_KEY);
    expect(rebuilt.wallet.pointsExpiryDays).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. getClientConfigFromDb — behavioural tests (Prisma mocked)
// ═════════════════════════════════════════════════════════════════════════════

describe('getClientConfigFromDb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars before each test
    delete process.env.DEOLEO_MSG91_AUTH_KEY;
    delete process.env.CLIENT_B_MSG91_AUTH_KEY;
  });

  it('returns a reconstructed ClientConfig when Prisma returns a row', async () => {
    // Build a realistic DB row from the known registry config
    const row = clientConfigToRow(DEOLEO_CONFIG);
    // Simulate Prisma row with updatedAt/createdAt added
    const prismaRow = {
      ...row,
      onboardedAt: row.onboardedAt, // already a Date
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(prismaRow);

    const result = await getClientConfigFromDb('deoleo');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('deoleo');
    // The DB path sources the secret from the registry (evaluated at import time).
    // In the test environment DEOLEO_MSG91_AUTH_KEY is unset, so both the
    // registry and the DB path resolve to the registry's fallback 'DEMO_KEY'.
    expect(result!.notifications.msg91AuthKey).toBe(DEOLEO_CONFIG.notifications.msg91AuthKey);
    expect(result!.branding.primaryColor).toBe('#16a34a');
  });

  it('uses DEMO_KEY as the fallback when no env var is set (deoleo)', async () => {
    const row = clientConfigToRow(DEOLEO_CONFIG);
    mockPrismaClient.client.findUnique.mockResolvedValueOnce({
      ...row,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // No env var set — registry resolves process.env.DEOLEO_MSG91_AUTH_KEY ?? 'DEMO_KEY'
    const result = await getClientConfigFromDb('deoleo');
    expect(result!.notifications.msg91AuthKey).toBe('DEMO_KEY');
    // Must also match what the registry itself reports
    expect(result!.notifications.msg91AuthKey).toBe(DEOLEO_CONFIG.notifications.msg91AuthKey);
  });

  it('resolves clientb secret from the registry (which reads CLIENT_B_MSG91_AUTH_KEY, not CLIENTB_MSG91_AUTH_KEY)', async () => {
    // The old buggy code derived CLIENTB_MSG91_AUTH_KEY from the slug, which
    // cannot reproduce CLIENT_B_MSG91_AUTH_KEY — the real env var name the
    // registry uses for slug 'clientb'. The fix sources the secret directly
    // from CLIENT_REGISTRY[clientId].notifications.msg91AuthKey instead of
    // re-deriving the var name from the slug.
    //
    // NOTE: env vars are evaluated at module import time, not per-call.
    // Setting CLIENT_B_MSG91_AUTH_KEY in beforeEach does not affect the
    // already-imported registry value. The invariant we can assert here is:
    // getClientConfigFromDb returns EXACTLY the same secret as the registry.
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    mockPrismaClient.client.findUnique.mockResolvedValueOnce({
      ...row,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await getClientConfigFromDb('clientb');
    // The strongest assertion: DB path secret equals registry's resolved secret.
    // In the test environment CLIENT_B_MSG91_AUTH_KEY is unset, so both resolve
    // to the registry fallback 'DEMO_KEY_B'.
    expect(result!.notifications.msg91AuthKey).toBe('DEMO_KEY_B');
    expect(result!.notifications.msg91AuthKey).toBe(CLIENT_B_CONFIG.notifications.msg91AuthKey);
  });

  it('falls back to DEMO_KEY_B (registry fallback) for clientb when CLIENT_B_MSG91_AUTH_KEY is unset', async () => {
    const row = clientConfigToRow(CLIENT_B_CONFIG);
    mockPrismaClient.client.findUnique.mockResolvedValueOnce({
      ...row,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // CLIENT_B_MSG91_AUTH_KEY is deliberately unset — registry falls back to 'DEMO_KEY_B'
    const result = await getClientConfigFromDb('clientb');
    expect(result!.notifications.msg91AuthKey).toBe('DEMO_KEY_B');
    // The strongest assertion: DB path secret equals registry's resolved secret
    expect(result!.notifications.msg91AuthKey).toBe(CLIENT_B_CONFIG.notifications.msg91AuthKey);
  });

  it('DB-path secret always matches registry secret for deoleo (invariant)', async () => {
    // This is the key correctness invariant: whatever the registry resolves for
    // msg91AuthKey (at import time, from the env or its fallback), the DB path
    // must return the exact same value — no re-derivation from the slug.
    const row = clientConfigToRow(DEOLEO_CONFIG);
    mockPrismaClient.client.findUnique.mockResolvedValueOnce({
      ...row,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await getClientConfigFromDb('deoleo');
    expect(result!.notifications.msg91AuthKey).toBe(DEOLEO_CONFIG.notifications.msg91AuthKey);
  });

  it('returns null when Prisma returns null (no row)', async () => {
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(null);

    const result = await getClientConfigFromDb('unknown-slug');
    expect(result).toBeNull();
  });

  it('returns null when Prisma throws (DB error)', async () => {
    mockPrismaClient.client.findUnique.mockRejectedValueOnce(new Error('DB unavailable'));

    const result = await getClientConfigFromDb('deoleo');
    expect(result).toBeNull();
  });

  it('queries by the supplied clientId', async () => {
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(null);

    await getClientConfigFromDb('my-tenant');
    expect(mockPrismaClient.client.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'my-tenant' } })
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. getTenantConfig — fallback chain tests
// ═════════════════════════════════════════════════════════════════════════════

describe('getTenantConfig — fallback chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEOLEO_MSG91_AUTH_KEY;
  });

  it('returns DB config when DB path succeeds', async () => {
    mockHeadersGet.mockReturnValue('deoleo');
    const row = clientConfigToRow(DEOLEO_CONFIG);
    mockPrismaClient.client.findUnique.mockResolvedValueOnce({
      ...row,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const config = await getTenantConfig();
    expect(config.slug).toBe('deoleo');
    // Secret is sourced from the registry (evaluated at import time).
    // Both the DB path and the direct registry value must agree.
    expect(config.notifications.msg91AuthKey).toBe(DEOLEO_CONFIG.notifications.msg91AuthKey);
  });

  it('falls back to registry config when DB returns null', async () => {
    mockHeadersGet.mockReturnValue('deoleo');
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(null);

    const config = await getTenantConfig();
    // Should be the registry config
    expect(config.slug).toBe('deoleo');
    // Registry key from DEOLEO_CONFIG — process.env.DEOLEO_MSG91_AUTH_KEY ?? 'DEMO_KEY'
    expect(config.notifications.msg91AuthKey).toBeDefined();
  });

  it('falls back to registry config when DB throws', async () => {
    mockHeadersGet.mockReturnValue('deoleo');
    mockPrismaClient.client.findUnique.mockRejectedValueOnce(new Error('timeout'));

    const config = await getTenantConfig();
    expect(config.slug).toBe('deoleo');
  });

  it('returns DEOLEO_CONFIG when no slug header is present', async () => {
    mockHeadersGet.mockReturnValue(null);
    // DB should never be queried when there is no slug
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(null);

    const config = await getTenantConfig();
    expect(config.slug).toBe('deoleo');
    expect(mockPrismaClient.client.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to DEOLEO_CONFIG for an unknown slug not in DB or registry', async () => {
    mockHeadersGet.mockReturnValue('unknown-tenant');
    mockPrismaClient.client.findUnique.mockResolvedValueOnce(null);

    const config = await getTenantConfig();
    expect(config.slug).toBe('deoleo');
  });
});

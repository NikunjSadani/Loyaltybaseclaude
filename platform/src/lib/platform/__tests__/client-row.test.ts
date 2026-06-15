/**
 * Pure unit tests for clientConfigToRow.
 * No database, no Prisma, no I/O.
 *
 * Run: npx vitest run src/lib/platform/__tests__/client-row.test.ts
 */

import { describe, it, expect } from 'vitest';
import { clientConfigToRow } from '../client-row';
import { DEOLEO_CONFIG, CLIENT_B_CONFIG } from '../client-registry';

// ─────────────────────────────────────────────────────────────────────────────
// Deoleo
// ─────────────────────────────────────────────────────────────────────────────

describe('clientConfigToRow — DEOLEO_CONFIG', () => {
  const row = clientConfigToRow(DEOLEO_CONFIG);

  it('id equals the slug', () => {
    expect(row.id).toBe('deoleo');
    expect(row.id).toBe(DEOLEO_CONFIG.slug);
  });

  it('internalName is carried through', () => {
    expect(row.internalName).toBe('Deoleo India Pvt. Ltd.');
  });

  it('status is ACTIVE', () => {
    expect(row.status).toBe('ACTIVE');
  });

  it('onboardedAt is a Date object', () => {
    expect(row.onboardedAt).toBeInstanceOf(Date);
    expect(row.onboardedAt.toISOString()).toContain('2025-01-01');
  });

  it('branding block is present and has displayName', () => {
    expect(row.branding).toBeDefined();
    expect(row.branding.displayName).toBe('Deoleo India');
    expect(row.branding.primaryColor).toBe('#16a34a');
  });

  it('features block is present', () => {
    expect(row.features).toBeDefined();
    expect(row.features.walletModule).toBe(true);
    expect(row.features.visibilityInvoiceModule).toBe(true);
  });

  it('partnerClasses block is present and non-empty', () => {
    expect(Array.isArray(row.partnerClasses)).toBe(true);
    expect(row.partnerClasses.length).toBeGreaterThan(0);
    const gold = row.partnerClasses.find((c) => c.key === 'GOLD');
    expect(gold).toBeDefined();
  });

  it('approvalHierarchy block is present', () => {
    expect(row.approvalHierarchy).toBeDefined();
    expect(row.approvalHierarchy.levels.length).toBeGreaterThanOrEqual(1);
  });

  it('invoicing block is present', () => {
    expect(row.invoicing).toBeDefined();
    expect(row.invoicing.invoicePrefix).toBe('TGSL-VIS');
  });

  it('wallet block is present', () => {
    expect(row.wallet).toBeDefined();
    expect(typeof row.wallet.defaultHoldingPeriodDays).toBe('number');
  });

  // ── Secret guard ────────────────────────────────────────────────────────────

  it('notifications block does NOT contain msg91AuthKey', () => {
    const notif = row.notifications as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(notif, 'msg91AuthKey')).toBe(false);
    expect('msg91AuthKey' in notif).toBe(false);
  });

  it('notifications block retains non-secret fields', () => {
    expect(row.notifications.whatsappSenderId).toBeDefined();
    expect(row.notifications.smsSenderId).toBe('DEOLEO');
    expect(row.notifications.templateIds).toBeDefined();
    expect(row.notifications.templateIds.otpVerification).toBe('deoleo_otp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client B
// ─────────────────────────────────────────────────────────────────────────────

describe('clientConfigToRow — CLIENT_B_CONFIG', () => {
  const row = clientConfigToRow(CLIENT_B_CONFIG);

  it('id equals the slug', () => {
    expect(row.id).toBe('clientb');
    expect(row.id).toBe(CLIENT_B_CONFIG.slug);
  });

  it('status is ONBOARDING', () => {
    expect(row.status).toBe('ONBOARDING');
  });

  it('onboardedAt is a Date object', () => {
    expect(row.onboardedAt).toBeInstanceOf(Date);
    expect(row.onboardedAt.toISOString()).toContain('2026-06-01');
  });

  it('branding.primaryColor differs from Deoleo', () => {
    expect(row.branding.primaryColor).toBe('#2563eb');
  });

  it('features.visibilityInvoiceModule is false', () => {
    expect(row.features.visibilityInvoiceModule).toBe(false);
  });

  it('wallet.pointsExpiryDays is null (points never expire)', () => {
    expect(row.wallet.pointsExpiryDays).toBeNull();
  });

  it('invoicing.invoicePrefix is TGSL-CLB', () => {
    expect(row.invoicing.invoicePrefix).toBe('TGSL-CLB');
  });

  it('notifications block does NOT contain msg91AuthKey', () => {
    const notif = row.notifications as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(notif, 'msg91AuthKey')).toBe(false);
    expect('msg91AuthKey' in notif).toBe(false);
  });

  it('notifications retains smsSenderId', () => {
    expect(row.notifications.smsSenderId).toBe('CLNTB');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting invariant: ids are unique across registry entries
// ─────────────────────────────────────────────────────────────────────────────

describe('clientConfigToRow — cross-tenant invariants', () => {
  const deoleoRow = clientConfigToRow(DEOLEO_CONFIG);
  const clientBRow = clientConfigToRow(CLIENT_B_CONFIG);

  it('each tenant maps to a distinct id', () => {
    expect(deoleoRow.id).not.toBe(clientBRow.id);
  });

  it('neither row carries msg91AuthKey', () => {
    for (const row of [deoleoRow, clientBRow]) {
      const notif = row.notifications as Record<string, unknown>;
      expect('msg91AuthKey' in notif).toBe(false);
    }
  });
});

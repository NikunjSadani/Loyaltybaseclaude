import { describe, it, expect } from 'vitest';
import { selectAdminNav, type AdminNavContext } from '@/lib/admin-nav';
import { TRADE_CAPABILITIES, type Capabilities } from '@/lib/tenant-features';

const EMPLOYEE_CAPS: Capabilities = {
  earnerModel: 'EMPLOYEE',
  kyc: false, gst: false, tds: false, payouts: false, invoicing: false,
  vendorMarketplace: true, celebratoryUx: true,
};

// Trade feature-flags ON so flag-gated trade items can appear in the trade-tree tests.
const TRADE_FEATURES: Record<string, boolean> = {
  kycApprovalFlow: true,
  walletModule: true,
  visibilityInvoiceModule: true,
};

function labels(ctx: AdminNavContext): string[] {
  return selectAdminNav(ctx).map((i) => i.label);
}

describe('selectAdminNav — capability-gated admin nav (two worlds, one shell)', () => {
  it('TRADE tenant (GIFSY_ADMIN) shows the trade compliance nav and never employee items', () => {
    const l = labels({
      capabilities: TRADE_CAPABILITIES, role: 'GIFSY_ADMIN',
      canManageSchemes: true, visibilityEnabled: true, features: TRADE_FEATURES,
    });
    expect(l).toContain('KYC Management');
    expect(l).toContain('Payout Management');
    expect(l).toContain('TDS & Invoicing');
    expect(l).toContain('Scheme Management');
    expect(l).not.toContain('People');
    expect(l).not.toContain('Contests');
  });

  it('EMPLOYEE tenant shows the employee cockpit and never a trade compliance surface', () => {
    const l = labels({
      capabilities: EMPLOYEE_CAPS, role: 'CLIENT_ADMIN',
      canManageSchemes: false, visibilityEnabled: false, features: {},
    });
    for (const m of ['People', 'Points', 'Contests', 'Rewards', 'Fulfilment', 'Finance', 'Communications', 'Insights', 'Content', 'Settings']) {
      expect(l).toContain(m);
    }
    for (const t of ['KYC Management', 'Payout Management', 'TDS & Invoicing', 'Scheme Management', 'Visibility (POSM)', 'Credits & Payouts']) {
      expect(l).not.toContain(t);
    }
  });

  it('role gates still apply inside the employee tree (Vendors is GIFSY_ADMIN-only)', () => {
    const base: AdminNavContext = {
      capabilities: EMPLOYEE_CAPS, role: 'CLIENT_ADMIN',
      canManageSchemes: false, visibilityEnabled: false, features: {},
    };
    expect(labels(base)).not.toContain('Vendors');
    expect(labels({ ...base, role: 'GIFSY_ADMIN', canManageSchemes: true })).toContain('Vendors');
  });

  it('TRADE tenant CLIENT_ADMIN hides gifsyOnly surfaces but keeps shared ones', () => {
    const l = labels({
      capabilities: TRADE_CAPABILITIES, role: 'CLIENT_ADMIN',
      canManageSchemes: false, visibilityEnabled: true, features: TRADE_FEATURES,
    });
    expect(l).not.toContain('Scheme Management'); // gifsyOnly
    expect(l).not.toContain('Payout Management'); // gifsyOnly
    expect(l).toContain('KYC Management');        // not gifsyOnly
    expect(l).toContain('Credits & Payouts');     // not gifsyOnly
  });

  it('fail-safe: TRADE defaults select the trade tree (never the employee world)', () => {
    const l = labels({
      capabilities: TRADE_CAPABILITIES, role: 'GIFSY_ADMIN',
      canManageSchemes: true, visibilityEnabled: true, features: TRADE_FEATURES,
    });
    expect(l).toContain('Credits & Payouts');
    expect(l).not.toContain('People');
  });
});

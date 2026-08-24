import { RedemptionStatus } from '@prisma/client';
import {
  applyVendorPiiRetention,
  shouldWithholdVendorPii,
  VENDOR_PII_RETENTION_DAYS,
} from './vendor-pii.helper';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const base = {
  deliveryName: 'Asha',
  deliveryPhone: '9990001111',
  deliveryAddressLine1: '1 MG Road',
  deliveryAddressLine2: null,
  deliveryCity: 'Pune',
  deliveryState: 'MH',
  deliveryPincode: '411001',
};

describe('vendor PII retention (decision #16)', () => {
  it('shows PII for an in-flight (non-terminal) order regardless of age', () => {
    const order = { status: RedemptionStatus.DISPATCHED, deliveredAt: null, cancelledAt: null, updatedAt: daysAgo(400) };
    expect(shouldWithholdVendorPii(order)).toBe(false);
  });

  it('shows PII within the retention window after DELIVERED', () => {
    const order = { status: RedemptionStatus.DELIVERED, deliveredAt: daysAgo(179), cancelledAt: null, updatedAt: daysAgo(179) };
    expect(shouldWithholdVendorPii(order)).toBe(false);
  });

  it('WITHHOLDS PII once >180d past DELIVERED', () => {
    const order = { status: RedemptionStatus.DELIVERED, deliveredAt: daysAgo(181), cancelledAt: null, updatedAt: daysAgo(181) };
    expect(shouldWithholdVendorPii(order)).toBe(true);
  });

  it('an OPEN return (RETURNED) PAUSES the clock — PII stays visible', () => {
    const order = { status: RedemptionStatus.RETURNED, deliveredAt: daysAgo(400), cancelledAt: null, updatedAt: daysAgo(400) };
    expect(shouldWithholdVendorPii(order)).toBe(false);
  });

  it('applyVendorPiiRetention nulls the PII fields + sets piiWithheld when aged out', () => {
    const order = {
      ...base,
      status: RedemptionStatus.CANCELLED,
      deliveredAt: null,
      cancelledAt: daysAgo(VENDOR_PII_RETENTION_DAYS + 1),
      updatedAt: daysAgo(VENDOR_PII_RETENTION_DAYS + 1),
    };
    const masked = applyVendorPiiRetention(order);
    expect(masked.piiWithheld).toBe(true);
    expect(masked.deliveryName).toBeNull();
    expect(masked.deliveryPincode).toBeNull();
  });

  describe('stable terminal timestamp (MED#4) — not resettable by updatedAt', () => {
    it('FAILED ages out from the status-history transition, NOT a bumped updatedAt', () => {
      // A recent updatedAt would (previously) restart the clock; the stable source is the
      // FAILED transition in status-history.
      const order = {
        status: RedemptionStatus.FAILED,
        deliveredAt: null,
        cancelledAt: null,
        updatedAt: daysAgo(1), // freshly bumped
        statusHistory: [{ toStatus: RedemptionStatus.FAILED, createdAt: daysAgo(200) }],
      };
      expect(shouldWithholdVendorPii(order)).toBe(true);
    });

    it('FAILED within window from status-history keeps PII even if updatedAt is old', () => {
      const order = {
        status: RedemptionStatus.FAILED,
        deliveredAt: null,
        cancelledAt: null,
        updatedAt: daysAgo(400),
        statusHistory: [{ toStatus: RedemptionStatus.FAILED, createdAt: daysAgo(10) }],
      };
      expect(shouldWithholdVendorPii(order)).toBe(false);
    });

    it('DELIVERED with a null deliveredAt STILL ages out via status-history (LOW#7)', () => {
      const order = {
        status: RedemptionStatus.DELIVERED,
        deliveredAt: null,
        cancelledAt: null,
        updatedAt: daysAgo(5),
        statusHistory: [{ toStatus: RedemptionStatus.DELIVERED, createdAt: daysAgo(190) }],
      };
      expect(shouldWithholdVendorPii(order)).toBe(true);
    });

    it('DELIVERED with null deliveredAt AND no history falls back to updatedAt (never visible forever)', () => {
      const order = {
        status: RedemptionStatus.DELIVERED,
        deliveredAt: null,
        cancelledAt: null,
        updatedAt: daysAgo(200),
      };
      expect(shouldWithholdVendorPii(order)).toBe(true);
    });
  });

  it('applyVendorPiiRetention keeps PII when within the window', () => {
    const order = {
      ...base,
      status: RedemptionStatus.DELIVERED,
      deliveredAt: daysAgo(10),
      cancelledAt: null,
      updatedAt: daysAgo(10),
    };
    const shown = applyVendorPiiRetention(order);
    expect(shown.piiWithheld).toBe(false);
    expect(shown.deliveryName).toBe('Asha');
  });
});

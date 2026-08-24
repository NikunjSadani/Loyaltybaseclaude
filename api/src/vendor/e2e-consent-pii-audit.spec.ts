/**
 * ADVERSARIAL AUDIT — CONSENT (#15) / PII-RETENTION (#16) / FE↔BE CONTRACT lane.
 * Final whole-module regression net for the Gift Catalogue & Dispatch module.
 *
 * Scope of THIS file (importable, DI-free units only):
 *   A. DPDP consent gate coercion (RedeemDto through the REAL global pipe options
 *      { transform:true, enableImplicitConversion:true }). Proves the fail-CLOSED
 *      invariant for the cases that hold, and PINS the one fail-OPEN case as a BUG.
 *   B. Vendor PII retention (#16) — day-179/180/181 boundary, RETURNED pause, and the
 *      STABLE-clock guarantee (a bumped updatedAt must never restart the clock).
 *
 * Run: cd api && npx jest src/vendor/e2e-consent-pii-audit.spec.ts --no-coverage
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RedeemDto } from '../rewards/dto/rewards.dto';
import { RedemptionStatus } from '@prisma/client';
import {
  applyVendorPiiRetention,
  shouldWithholdVendorPii,
  VENDOR_PII_FIELDS,
  VENDOR_PII_RETENTION_DAYS,
} from './vendor-pii.helper';

// The EXACT global pipe options from api/src/main.ts.
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;
const XFORM = { enableImplicitConversion: true } as const;

/** Reproduce what the ValidationPipe does to a redeem body, then read the consent value
 *  the service's resolveVendorConsent (`consent === true`) would actually see. */
function pipeConsent(raw: unknown): { value: unknown; errors: number } {
  const inst = plainToInstance(RedeemDto, { rewardId: 'r1', consent: raw }, XFORM) as {
    consent?: unknown;
  };
  const errors = validateSync(inst as object, PIPE);
  return { value: inst.consent, errors: errors.length };
}
/** The service gate: a VENDOR item is redeemable ONLY when the pipe-normalised value === true. */
const gateAllows = (raw: unknown) => pipeConsent(raw).value === true;

const MS_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_DAY);
const basePii = {
  deliveryName: 'Asha',
  deliveryPhone: '9990001111',
  deliveryAddressLine1: '1 MG Road',
  deliveryAddressLine2: 'Flat 2',
  deliveryCity: 'Pune',
  deliveryState: 'MH',
  deliveryPincode: '411001',
};

// ───────────────────────────────────────────────────────────────────────────
// A. CONSENT GATE (#15) — fail-CLOSED is the invariant (REGRESSION LOCK for C1)
//
// C1 was a fail-OPEN defect: under enableImplicitConversion class-transformer mapped
// ANY non-empty string ("false"/"0"/"no") to boolean true, so a negative/ambiguous
// string silently passed the service's `consent === true` DPDP gate and falsely
// attested consent. FIXED: RedeemDto.consent now strict-parses via
//   @Transform(({ obj }) => obj?.consent === true || obj?.consent === 'true')
// so ONLY a genuine boolean true or the exact string 'true' resolves to true; every
// other value resolves to false (fail-closed). These tests run the REAL RedeemDto
// through the REAL global-pipe options and lock that behaviour.
// ───────────────────────────────────────────────────────────────────────────
describe('CONSENT #15 — vendor-PII consent gate is fail-CLOSED (regression: strict-parse @Transform)', () => {
  it('a REAL boolean true is accepted → gate ALLOWS (no validation error)', () => {
    const { value, errors } = pipeConsent(true);
    expect(value).toBe(true);
    expect(errors).toBe(0);
    expect(gateAllows(true)).toBe(true);
  });

  it("the exact string 'true' is accepted → gate ALLOWS (no validation error)", () => {
    const { value, errors } = pipeConsent('true');
    expect(value).toBe(true);
    expect(errors).toBe(0);
    expect(gateAllows('true')).toBe(true);
  });

  // The core C1 fix: negative/ambiguous STRINGS must NOT manufacture consent.
  it.each(['false', '0', 'no'])(
    "a negative/ambiguous string %p → false → gate BLOCKS (fail-closed, no validation error)",
    (raw) => {
      const { value, errors } = pipeConsent(raw);
      expect(value).toBe(false);
      expect(errors).toBe(0);
      expect(gateAllows(raw)).toBe(false);
    },
  );

  it('OMITTED consent (key absent) → undefined → gate BLOCKS (fail-closed), no validation error', () => {
    // A real omission = the key is absent from the body (the @Transform does not run),
    // leaving consent undefined — distinct from an explicit consent:undefined.
    const inst = plainToInstance(RedeemDto, { rewardId: 'r1' }, XFORM) as { consent?: unknown };
    const errors = validateSync(inst as object, PIPE);
    expect(inst.consent).toBeUndefined();
    expect(errors.length).toBe(0);
  });

  it('a REAL boolean false → false → gate BLOCKS (fail-closed)', () => {
    const { value, errors } = pipeConsent(false);
    expect(value).toBe(false);
    expect(errors).toBe(0);
    expect(gateAllows(false)).toBe(false);
  });

  it('number 0 → false → gate BLOCKS', () => {
    expect(pipeConsent(0).value).toBe(false);
    expect(gateAllows(0)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. PII RETENTION (#16) — boundary + stable clock + RETURNED pause
// ───────────────────────────────────────────────────────────────────────────
describe('PII RETENTION #16 — 180-day boundary from a STABLE terminal timestamp', () => {
  const withDelivered = (terminalDaysAgo: number, updatedDaysAgo = terminalDaysAgo) => ({
    ...basePii,
    status: RedemptionStatus.DELIVERED,
    deliveredAt: daysAgo(terminalDaysAgo),
    cancelledAt: null,
    updatedAt: daysAgo(updatedDaysAgo),
  });

  it('day 179 after DELIVERED → PII SHOWN', () => {
    expect(shouldWithholdVendorPii(withDelivered(179))).toBe(false);
  });

  it('EXACT 180-day boundary → PII SHOWN (window is inclusive; withholding is strictly > 180d)', () => {
    // now - terminalAt == exactly 180d → ageMs === retentionMs → NOT withheld.
    const order = {
      ...basePii,
      status: RedemptionStatus.DELIVERED,
      deliveredAt: new Date(Date.now() - VENDOR_PII_RETENTION_DAYS * MS_DAY),
      cancelledAt: null,
      updatedAt: new Date(),
    };
    expect(shouldWithholdVendorPii(order, new Date())).toBe(false);
  });

  it('180 days + 1ms after DELIVERED → PII WITHHELD', () => {
    const now = new Date();
    const order = {
      ...basePii,
      status: RedemptionStatus.DELIVERED,
      deliveredAt: new Date(now.getTime() - (VENDOR_PII_RETENTION_DAYS * MS_DAY + 1)),
      cancelledAt: null,
      updatedAt: now,
    };
    expect(shouldWithholdVendorPii(order, now)).toBe(true);
  });

  it('RETURNED (open dispute) PAUSES the clock — PII stays visible however old', () => {
    const order = {
      ...basePii,
      status: RedemptionStatus.RETURNED,
      deliveredAt: daysAgo(900),
      cancelledAt: null,
      updatedAt: daysAgo(900),
    };
    expect(shouldWithholdVendorPii(order)).toBe(false);
  });

  it('STABLE clock: a freshly-bumped updatedAt does NOT restart the window for DELIVERED', () => {
    // deliveredAt (write-once) is 200d old but updatedAt was bumped 1d ago (e.g. a Gifsy
    // non-status edit). The clock must count from deliveredAt → still withheld.
    expect(shouldWithholdVendorPii(withDelivered(200, 1))).toBe(true);
  });

  it('STABLE clock: FAILED ages out from status-history, immune to a fresh updatedAt', () => {
    const order = {
      ...basePii,
      status: RedemptionStatus.FAILED,
      deliveredAt: null,
      cancelledAt: null,
      updatedAt: daysAgo(1),
      statusHistory: [{ toStatus: RedemptionStatus.FAILED, createdAt: daysAgo(200) }],
    };
    expect(shouldWithholdVendorPii(order)).toBe(true);
  });

  it('applyVendorPiiRetention nulls ALL 7 PII fields + flags piiWithheld once aged out', () => {
    const masked = applyVendorPiiRetention(withDelivered(VENDOR_PII_RETENTION_DAYS + 5));
    expect(masked.piiWithheld).toBe(true);
    for (const f of VENDOR_PII_FIELDS) {
      expect((masked as Record<string, unknown>)[f]).toBeNull();
    }
  });

  it('applyVendorPiiRetention keeps ALL PII within the window + piiWithheld=false', () => {
    const shown = applyVendorPiiRetention(withDelivered(10));
    expect(shown.piiWithheld).toBe(false);
    expect(shown.deliveryName).toBe('Asha');
    expect(shown.deliveryPincode).toBe('411001');
  });

  it('retention is view-time only — the source object is not mutated in place', () => {
    const order = withDelivered(VENDOR_PII_RETENTION_DAYS + 5);
    applyVendorPiiRetention(order);
    expect(order.deliveryName).toBe('Asha'); // original untouched (Gifsy/member keep full access)
  });
});

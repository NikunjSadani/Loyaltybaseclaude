/// <reference types="vitest/globals" />
/**
 * buildOrderSteps — the pure step model behind the partner My Orders stepper
 * (platform/docs/plans/ORDER-TIMELINE-STEPPER-PLAN.md §3 + owner decisions D1–D5).
 */
import { describe, it, expect } from 'vitest';
import {
  buildOrderSteps,
  orderKind,
  type HistoryEntry,
  type OrderTimelineInput,
  type OrderStep,
} from '../order-timeline';

const T0 = '2026-05-01T00:00:00.000Z'; // createdAt
const T1 = '2026-05-01T01:00:00.000Z';
const T2 = '2026-05-02T10:00:00.000Z';
const T3 = '2026-05-03T10:00:00.000Z';
const T4 = '2026-05-04T10:00:00.000Z';
const UPDATED = '2026-06-30T23:59:59.000Z'; // must NEVER surface as a step date

function order(over: Partial<OrderTimelineInput> = {}): OrderTimelineInput {
  return {
    status: 'PENDING',
    redemptionMode: 'PHYSICAL_GIFT',
    voucherCode: null,
    createdAt: T0,
    updatedAt: UPDATED,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    trackingNumber: null,
    ...over,
  };
}
const h = (fromStatus: string | null, toStatus: string, createdAt: string): HistoryEntry => ({ fromStatus, toStatus, createdAt });
const keys = (s: OrderStep[]) => s.map((x) => x.key);
const states = (s: OrderStep[]) => s.map((x) => x.state);
const byKey = (s: OrderStep[], k: string) => s.find((x) => x.key === k)!;

describe('orderKind', () => {
  it('voucher = GIFT_CARD / VOUCHER mode or a voucher code present (same rule as the page)', () => {
    expect(orderKind(order({ redemptionMode: 'GIFT_CARD' }))).toBe('voucher');
    expect(orderKind(order({ redemptionMode: 'VOUCHER' }))).toBe('voucher');
    expect(orderKind(order({ redemptionMode: 'PHYSICAL_GIFT', voucherCode: 'X' }))).toBe('voucher');
  });
  it('cash = UPI / BANK_TRANSFER; anything else (incl. missing) = physical', () => {
    expect(orderKind(order({ redemptionMode: 'UPI' }))).toBe('cash');
    expect(orderKind(order({ redemptionMode: 'BANK_TRANSFER' }))).toBe('cash');
    expect(orderKind(order({ redemptionMode: 'PHYSICAL_GIFT' }))).toBe('physical');
    expect(orderKind(order({ redemptionMode: null }))).toBe('physical');
  });
});

describe('buildOrderSteps — physical happy paths', () => {
  it('PENDING: placed is CURRENT (waiting for OTP, dated createdAt), confirmed and the rest upcoming', () => {
    const s = buildOrderSteps(order());
    expect(keys(s)).toEqual(['placed', 'confirmed', 'processing', 'dispatched', 'delivered']);
    expect(s.map((x) => x.label)).toEqual(['Order placed', 'Confirmed', 'Processing', 'Dispatched', 'Delivered']);
    expect(states(s)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(byKey(s, 'placed').sublabel).toBe('Waiting for OTP confirmation');
    expect(byKey(s, 'confirmed').sublabel).toBeUndefined();
    expect(byKey(s, 'placed').date).toBe(T0);
  });

  it('PENDING and CONFIRMED render differently (the confirm step only lights up once reached)', () => {
    const pending = buildOrderSteps(order({ status: 'PENDING' }));
    const confirmed = buildOrderSteps(order({ status: 'CONFIRMED' }));
    expect(states(pending)).not.toEqual(states(confirmed));
    expect(byKey(pending, 'confirmed').state).toBe('upcoming');
    expect(byKey(confirmed, 'confirmed').state).toBe('current');
    // so the compact caption's "next upcoming step" is Confirmed while pending
    expect(pending.find((x) => x.state === 'upcoming')!.label).toBe('Confirmed');
  });

  it('PROCESSING with history: earlier steps complete with history dates, processing current', () => {
    const s = buildOrderSteps(order({ status: 'PROCESSING' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'PROCESSING', T2)],
    });
    expect(states(s)).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming']);
    expect(byKey(s, 'confirmed').date).toBe(T1);
    expect(byKey(s, 'processing').date).toBe(T2);
  });

  it('DISPATCHED: dispatched current, dated from the column, with the tracking note', () => {
    const s = buildOrderSteps(order({ status: 'DISPATCHED', dispatchedAt: T3, trackingNumber: 'TN1' }));
    expect(states(s)).toEqual(['complete', 'complete', 'complete', 'current', 'upcoming']);
    expect(byKey(s, 'dispatched').date).toBe(T3);
    expect(byKey(s, 'dispatched').sublabel).toBe('Tracking: TN1');
  });

  it('DELIVERED: all five complete and NO step is current (a finished order)', () => {
    const s = buildOrderSteps(order({ status: 'DELIVERED', deliveredAt: T4 }));
    expect(states(s)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete']);
    expect(s.some((x) => x.state === 'current')).toBe(false);
  });

  it('CONFIRMED: placed complete, confirmed current without the OTP sublabel', () => {
    const s = buildOrderSteps(order({ status: 'CONFIRMED' }));
    expect(states(s)).toEqual(['complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(byKey(s, 'confirmed').sublabel).toBeUndefined();
  });
});

describe('buildOrderSteps — dates', () => {
  it('a history date beats the column date', () => {
    const s = buildOrderSteps(order({ status: 'DISPATCHED', dispatchedAt: '2026-05-03T10:00:05.000Z' }), {
      timeline: [h('PROCESSING', 'DISPATCHED', T3)],
    });
    expect(byKey(s, 'dispatched').date).toBe(T3);
  });

  it('the LATEST history row wins when two rows share a toStatus', () => {
    const s = buildOrderSteps(order({ status: 'PROCESSING' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'CONFIRMED', T2)],
    });
    expect(byKey(s, 'confirmed').date).toBe(T2);
  });

  it('unsorted history still yields the right dates and reached step', () => {
    const s = buildOrderSteps(order({ status: 'CANCELLED', cancelledAt: T4 }), {
      timeline: [h('PROCESSING', 'CANCELLED', T3), h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'PROCESSING', T2)],
    });
    expect(keys(s)).toEqual(['placed', 'confirmed', 'processing', 'cancelled']);
    expect(byKey(s, 'confirmed').date).toBe(T1);
    expect(byKey(s, 'processing').date).toBe(T2);
    expect(byKey(s, 'cancelled').date).toBe(T3);
  });

  it('legacy, no history: skipped steps are complete WITHOUT a date; delivered uses deliveredAt', () => {
    const s = buildOrderSteps(order({ status: 'DELIVERED', deliveredAt: T4 }));
    for (const k of ['confirmed', 'processing', 'dispatched']) {
      expect(byKey(s, k).state).toBe('complete');
      expect(byKey(s, k).date).toBeUndefined();
    }
    expect(byKey(s, 'delivered').date).toBe(T4);
  });

  it('never uses updatedAt, and never produces an "Invalid Date"/"undefined" date', () => {
    const fixtures: OrderTimelineInput[] = [
      order({ status: 'FAILED' }),
      order({ status: 'RETURNED' }),
      order({ status: 'CANCELLED' }),
      order({ status: 'REVERSED' }),
      order({ status: 'DELIVERED', redemptionMode: 'UPI' }),
    ];
    for (const f of fixtures) {
      for (const step of buildOrderSteps(f)) {
        expect(step.date).not.toBe(UPDATED);
        if (step.date !== undefined) {
          expect(Number.isNaN(new Date(step.date).getTime())).toBe(false);
        }
      }
    }
  });
});

describe('buildOrderSteps — vouchers', () => {
  it('Hubble voucher (CONFIRMED→DELIVERED, fromStatus null): 3 steps all complete, issued dated from history, confirmed undated', () => {
    const s = buildOrderSteps(order({ status: 'DELIVERED', redemptionMode: 'GIFT_CARD', voucherCode: 'C1' }), {
      timeline: [h(null, 'DELIVERED', T2)],
    });
    expect(keys(s)).toEqual(['placed', 'confirmed', 'issued']);
    expect(s.map((x) => x.label)).toEqual(['Order placed', 'Confirmed', 'Voucher issued']);
    expect(states(s)).toEqual(['complete', 'complete', 'complete']);
    expect(byKey(s, 'issued').date).toBe(T2);
    expect(byKey(s, 'confirmed').date).toBeUndefined();
  });

  it('manual voucher stuck in DISPATCHED without a code: issued is current, "Being processed"', () => {
    const s = buildOrderSteps(order({ status: 'DISPATCHED', redemptionMode: 'GIFT_CARD' }));
    expect(states(s)).toEqual(['complete', 'complete', 'current']);
    expect(byKey(s, 'issued').sublabel).toBe('Being processed');
  });

  it('a PENDING voucher waits on the OTP; a CONFIRMED one sits on Confirmed (issued stays upcoming)', () => {
    const p = buildOrderSteps(order({ status: 'PENDING', redemptionMode: 'GIFT_CARD' }));
    expect(states(p)).toEqual(['current', 'upcoming', 'upcoming']);
    expect(byKey(p, 'placed').sublabel).toBe('Waiting for OTP confirmation');
    const c = buildOrderSteps(order({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD' }));
    expect(states(c)).toEqual(['complete', 'current', 'upcoming']);
    expect(byKey(c, 'issued').sublabel).toBeUndefined();
  });

  it('a voucher with its code set is issued (complete) even before DELIVERED', () => {
    const s = buildOrderSteps(order({ status: 'DISPATCHED', redemptionMode: 'GIFT_CARD', voucherCode: 'C1' }));
    expect(states(s)).toEqual(['complete', 'complete', 'complete']);
  });
});

describe('buildOrderSteps — cash', () => {
  it('UPI DELIVERED with no DELIVERED history row: "Paid to your bank" complete, dated from deliveredAt', () => {
    const s = buildOrderSteps(order({ status: 'DELIVERED', redemptionMode: 'UPI', deliveredAt: T4 }));
    expect(s.map((x) => x.label)).toEqual(['Request placed', 'Confirmed', 'Paid to your bank']);
    expect(states(s)).toEqual(['complete', 'complete', 'complete']);
    expect(byKey(s, 'paid').date).toBe(T4);
  });

  it('BANK_TRANSFER FAILED: placed ✓ confirmed ✓ then "Payment failed" (dated from its history row)', () => {
    const s = buildOrderSteps(order({ status: 'FAILED', redemptionMode: 'BANK_TRANSFER' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'FAILED', T3)],
      refundedAt: T3,
    });
    expect(keys(s)).toEqual(['placed', 'confirmed', 'failed']);
    expect(states(s)).toEqual(['complete', 'complete', 'failed']);
    expect(byKey(s, 'failed').label).toBe('Payment failed');
    expect(byKey(s, 'failed').date).toBe(T3);
    expect(byKey(s, 'failed').sublabel).toBe('Points refunded to your wallet');
  });

  it('PENDING cash request waits on the OTP; CONFIRMED sits on Confirmed; "Paid to your bank" upcoming', () => {
    expect(states(buildOrderSteps(order({ status: 'PENDING', redemptionMode: 'UPI' })))).toEqual(['current', 'upcoming', 'upcoming']);
    expect(states(buildOrderSteps(order({ status: 'CONFIRMED', redemptionMode: 'UPI' })))).toEqual(['complete', 'current', 'upcoming']);
  });

  it('legacy cash FAILED with no FAILED history row: the failed step has NO date', () => {
    const s = buildOrderSteps(order({ status: 'FAILED', redemptionMode: 'UPI' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1)],
    });
    expect(byKey(s, 'failed').date).toBeUndefined();
  });
});

describe('buildOrderSteps — terminal branches', () => {
  it('cancelled after confirm: placed ✓ confirmed ✓ Cancelled (failed, dated) — no upcoming steps remain', () => {
    const s = buildOrderSteps(order({ status: 'CANCELLED', cancelledAt: '2026-05-02T00:00:09.000Z' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'CANCELLED', T2)],
      refundedAt: T2,
    });
    expect(keys(s)).toEqual(['placed', 'confirmed', 'cancelled']);
    expect(states(s)).toEqual(['complete', 'complete', 'failed']);
    expect(byKey(s, 'cancelled').label).toBe('Cancelled');
    expect(byKey(s, 'cancelled').date).toBe(T2);
    expect(s.some((x) => x.state === 'upcoming')).toBe(false);
  });

  it('cancelled without history falls back to the cancelledAt column', () => {
    const s = buildOrderSteps(order({ status: 'CANCELLED', cancelledAt: T4 }));
    expect(byKey(s, 'cancelled').date).toBe(T4);
  });

  it('failed from processing: 3 complete + Failed', () => {
    const s = buildOrderSteps(order({ status: 'FAILED' }), {
      timeline: [h('PENDING', 'CONFIRMED', T1), h('CONFIRMED', 'PROCESSING', T2), h('PROCESSING', 'FAILED', T3)],
    });
    expect(keys(s)).toEqual(['placed', 'confirmed', 'processing', 'failed']);
    expect(states(s)).toEqual(['complete', 'complete', 'complete', 'failed']);
    expect(byKey(s, 'failed').label).toBe('Failed');
  });

  it('returned after delivery (no history): all physical steps through delivered complete, then Returned (undated)', () => {
    const s = buildOrderSteps(order({ status: 'RETURNED', dispatchedAt: T3, deliveredAt: T4 }));
    expect(keys(s)).toEqual(['placed', 'confirmed', 'processing', 'dispatched', 'delivered', 'returned']);
    expect(states(s)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete', 'failed']);
    expect(byKey(s, 'returned').label).toBe('Returned');
    expect(byKey(s, 'returned').date).toBeUndefined();
  });

  it('D5: refund copy appears ONLY when a refund was recorded (refundedAt set)', () => {
    const base = order({ status: 'RETURNED', deliveredAt: T4 });
    expect(byKey(buildOrderSteps(base), 'returned').sublabel).toBeUndefined();
    expect(byKey(buildOrderSteps(base, { timeline: [], refundedAt: null }), 'returned').sublabel).toBeUndefined();
    expect(byKey(buildOrderSteps(base, { timeline: [], refundedAt: T4 }), 'returned').sublabel).toBe(
      'Points refunded to your wallet',
    );
  });

  it('D5: refund copy never appears on a non-terminal order', () => {
    const s = buildOrderSteps(order({ status: 'DELIVERED', deliveredAt: T4 }), { timeline: [], refundedAt: T4 });
    expect(s.some((x) => x.sublabel === 'Points refunded to your wallet')).toBe(false);
  });
});

describe('buildOrderSteps — unknown status', () => {
  it('REVERSED (not a backend status): placed ✓ plus one current step labelled with the raw status, never throws', () => {
    const s = buildOrderSteps(order({ status: 'REVERSED' }));
    expect(keys(s)).toEqual(['placed', 'status']);
    expect(states(s)).toEqual(['complete', 'current']);
    expect(s[1].label).toBe('REVERSED');
  });
});

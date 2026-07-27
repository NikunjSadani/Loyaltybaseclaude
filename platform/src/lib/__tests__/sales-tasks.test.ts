/// <reference types="vitest/globals" />
/**
 * ST — shared sales-task derivation (buildKycSubRows + buildVisibilityTaskItems).
 *
 * These power BOTH the sales dashboard and the Tasks page, so the owner-reported
 * "Approval Required is different in both views" (one counted outlets, the other
 * counted submissions) can't recur. Locking the canonical behavior here.
 */

import { describe, it, expect } from 'vitest';
import { buildKycSubRows, buildVisibilityTaskItems, buildPhotoCaptureTaskItems } from '../sales-tasks';
import { KYCStatus } from '@/types';
import type { SalesEligibleResponse } from '@/lib/visibility-types';

describe('ST — buildKycSubRows', () => {
  it('ST1: dedupes to the LATEST submission per outletCode', () => {
    const rows = buildKycSubRows({ success: true, data: { submissions: [
      { id: 'a', status: 'PENDING_SO_APPROVAL', updatedAt: '2026-06-01', partner: { outlets: [{ name: 'Verma', outletCode: 'O1' }] } },
      { id: 'b', status: 'APPROVED',            updatedAt: '2026-06-10', partner: { outlets: [{ name: 'Verma', outletCode: 'O1' }] } },
    ] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('b'); // the later updatedAt wins
    expect(rows[0].status).toBe(KYCStatus.APPROVED);
  });

  it('ST2: keeps no-outlet submissions individually (the Anil-Sharma case)', () => {
    const rows = buildKycSubRows({ success: true, data: { submissions: [
      { id: 'o1', status: 'PENDING_SO_APPROVAL', partner: { outlets: [{ name: 'Verma', outletCode: 'O1' }] } },
      { id: 'no', status: 'PENDING_SO_APPROVAL', user: { name: 'Anil Sharma' } }, // no outlet
    ] } });
    // BOTH count toward Approval Required — this is the count that was missing on
    // the outlet-derived Tasks page (1) vs the submission-derived dashboard (2).
    const approval = rows.filter((r) => r.status === KYCStatus.PENDING_SO_APPROVAL);
    expect(approval).toHaveLength(2);
    expect(rows.find((r) => r.id === 'no')?.title).toBe('Anil Sharma'); // falls back to the rep name
  });

  it('ST3: title precedence outlet → firm → rep; bad payload → []', () => {
    expect(buildKycSubRows(null)).toEqual([]);
    expect(buildKycSubRows({ success: false })).toEqual([]);
    const [firm] = buildKycSubRows({ success: true, data: { submissions: [
      { id: 'f', status: 'PENDING_SO_APPROVAL', partner: { businessName: 'Verma Traders' } },
    ] } });
    expect(firm.title).toBe('Verma Traders');
  });
});

describe('ST — buildVisibilityTaskItems', () => {
  const outlets = [
    { id: '1', name: 'A', location: 'Beat1', outletCode: 'O1' },
    { id: '2', name: 'B', location: 'Beat2', outletCode: 'O2' },
    { id: '3', name: 'C', location: 'Beat3', outletCode: 'O3' },
  ];

  it('ST4: excludes APPROVED; UNDER_REVIEW → medium; pending → high', () => {
    const items = buildVisibilityTaskItems(outlets, {
      O1: { status: 'APPROVED' },     // excluded
      O2: { status: 'UNDER_REVIEW' }, // medium
      O3: undefined,                  // not captured → high
    }, true); // visibilityEnabled — master switch on
    expect(items.map((i) => i.id)).toEqual(['vis-2', 'vis-3']);
    expect(items.find((i) => i.id === 'vis-2')?.priority).toBe('medium');
    expect(items.find((i) => i.id === 'vis-3')?.priority).toBe('high');
    expect(items.every((i) => i.href === '/sales/visibility')).toBe(true);
  });

  it('ST5: master Visibility switch OFF (or omitted) → no task items', () => {
    const statusMap = { O1: undefined, O2: undefined, O3: undefined };
    // Omitted flag → default OFF.
    expect(buildVisibilityTaskItems(outlets, statusMap)).toEqual([]);
    // Explicit false → OFF.
    expect(buildVisibilityTaskItems(outlets, statusMap, false)).toEqual([]);
  });
});

describe('ST — buildPhotoCaptureTaskItems (PHOTO_APPROVAL mode)', () => {
  const outlet = (over: Partial<SalesEligibleResponse['outlets'][number]>) => ({
    outletId: 'x', outletCode: 'C', outletName: 'N', zone: null, state: null,
    outletType: null, captureId: null, status: null, currentVersion: null,
    rejectionReason: null, windowState: 'due' as const, canCapture: true,
    ...over,
  });
  const resp = (outlets: SalesEligibleResponse['outlets']): SalesEligibleResponse => ({
    windowKey: '2026-07-P1', window: { startDay: 1, endDay: 15 }, levelAllowed: true, outlets,
  });

  it('ST6: includes only canCapture outlets in due/rejected/late; excludes awaiting/approved + view-only', () => {
    const items = buildPhotoCaptureTaskItems(resp([
      outlet({ outletId: 'due',    windowState: 'due' }),
      outlet({ outletId: 'rej',    windowState: 'rejected', captureId: 'c1', rejectionReason: 'Blurry' }),
      outlet({ outletId: 'late',   windowState: 'late' }),
      outlet({ outletId: 'await',  windowState: 'awaiting' }),   // excluded (submitted)
      outlet({ outletId: 'appr',   windowState: 'approved' }),   // excluded (satisfied)
      outlet({ outletId: 'viewer', windowState: 'due', canCapture: false }), // excluded (D8 view-only)
    ]));
    expect(items.map((i) => i.id)).toEqual(['vis-due', 'vis-rej', 'vis-late']);
    // Deep-links preselect the outlet on the capture list.
    expect(items[0].href).toBe('/sales/visibility?outletId=due');
    // Rejection reason surfaces in the subtitle.
    expect(items.find((i) => i.id === 'vis-rej')?.subtitle).toContain('Blurry');
    expect(items.every((i) => i.priority === 'high')).toBe(true);
  });

  it('ST7: null / empty response → no items', () => {
    expect(buildPhotoCaptureTaskItems(null)).toEqual([]);
    expect(buildPhotoCaptureTaskItems(undefined)).toEqual([]);
    expect(buildPhotoCaptureTaskItems(resp([]))).toEqual([]);
  });
});

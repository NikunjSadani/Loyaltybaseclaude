import React from 'react';
import { Badge } from '@/components/ui/badge';
import type { UpiCaptureMethod } from '@/components/bank-or-upi-section';

/** Narrow an untyped wire value to a known capture method; anything else → null (unknown). */
export function asUpiCaptureMethod(v: unknown): UpiCaptureMethod | null {
  return v === 'QR' || v === 'MANUAL' ? v : null;
}

/**
 * The capture method a reviewer should see, mirroring the backend's stage-at-approval overlay:
 * a re-KYC's `proposedPartner` key (value OR explicit null) wins; else the live partner value.
 */
export function effectiveUpiCaptureMethod(
  partner: { upiCaptureMethod?: unknown } | null | undefined,
  proposedPartner: Record<string, unknown> | null | undefined,
): UpiCaptureMethod | null {
  if (proposedPartner && typeof proposedPartner === 'object' && 'upiCaptureMethod' in proposedPartner) {
    return asUpiCaptureMethod(proposedPartner.upiCaptureMethod);
  }
  return asUpiCaptureMethod(partner?.upiCaptureMethod);
}

/** Tooltip prefix: the method is what was RECORDED when the UPI ID was captured (client-reported,
 *  not server-verified provenance) — and a grouped child may have inherited the UPI ID (and its
 *  method) from the outlet group, so the copy must not imply this submission captured it. */
export const UPI_CAPTURE_TOOLTIP_PREFIX =
  'As recorded when the UPI ID was captured (may be inherited from the outlet group)';

/**
 * Reviewer badge next to a UPI ID: "Scanned" (QR) or "Typed" (MANUAL, warning style — a typed
 * VPA carries typo risk). Renders nothing when the method is unknown (null/legacy).
 */
export function UpiCaptureMethodBadge({ method }: { method: UpiCaptureMethod | null | undefined }) {
  if (method === 'QR') {
    return (
      <Badge variant="success" className="ml-1.5 font-sans" data-testid="upi-capture-badge" title={`${UPI_CAPTURE_TOOLTIP_PREFIX}: scanned from a QR code`}>
        Scanned
      </Badge>
    );
  }
  if (method === 'MANUAL') {
    return (
      <Badge variant="warning" className="ml-1.5 font-sans" data-testid="upi-capture-badge" title={`${UPI_CAPTURE_TOOLTIP_PREFIX}: typed by hand — double-check it`}>
        Typed
      </Badge>
    );
  }
  return null;
}

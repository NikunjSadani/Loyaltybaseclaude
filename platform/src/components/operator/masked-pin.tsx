'use client';

import { useState } from 'react';

/**
 * A gift-card PIN on an OPERATOR / VENDOR screen: hidden ("••••") by default behind a per-row
 * "Show" toggle. The state is local to the mounted row, so it re-hides on any navigation /
 * remount. The member's own orders page shows the PIN openly (they need it) and does NOT use this.
 *
 * Accessibility — the LABEL-FLIP pattern (no aria-pressed: a flipping name PLUS a pressed state
 * double-announces it): the visible text is "Show PIN" / "Hide PIN" and the accessible name
 * CONTAINS it ("Show PIN for order <orderNumber>" / "Hide PIN for order <orderNumber>", or
 * "… for the card" without an order number) — so voice-control users can say what they see.
 */
export function MaskedPin({
  pin,
  label = 'PIN',
  orderNumber,
  className,
  testId,
}: {
  pin: string;
  /** Visible label before the value. */
  label?: string;
  /** Names the toggle for screen readers: "Show PIN for order <orderNumber>" / "Hide PIN for …". */
  orderNumber?: string | null;
  className?: string;
  testId?: string;
}) {
  const [shown, setShown] = useState(false);
  const visible = shown ? 'Hide PIN' : 'Show PIN';
  const accessibleName = `${visible} ${orderNumber?.trim() ? `for order ${orderNumber.trim()}` : 'for the card'}`;
  return (
    <span className={className} data-testid={testId}>
      {label}{' '}
      <span className="font-mono" data-testid={testId ? `${testId}-value` : undefined}>
        {shown ? pin : '••••'}
      </span>{' '}
      <button
        type="button"
        aria-label={accessibleName}
        onClick={() => setShown((s) => !s)}
        className="ml-1 text-[10px] font-semibold underline text-gray-600 hover:text-gray-900"
      >
        {visible}
      </button>
    </span>
  );
}

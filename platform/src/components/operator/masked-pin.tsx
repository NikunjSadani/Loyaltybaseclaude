'use client';

import { useState } from 'react';

/**
 * A gift-card PIN on an OPERATOR / VENDOR screen: hidden ("••••") by default behind a per-row
 * "Show" toggle. The state is local to the mounted row, so it re-hides on any navigation /
 * remount. The member's own orders page shows the PIN openly (they need it) and does NOT use this.
 *
 * Accessibility: the toggle's accessible name is FIXED — "Show PIN for order <orderNumber>" (or
 * "Show PIN for the card" without an order number) — and its state is conveyed ONLY by
 * aria-pressed (a name that flips "Show"/"Hide" on a pressed toggle double-announces the state).
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
  /** Names the toggle for screen readers: "Show PIN for order <orderNumber>". */
  orderNumber?: string | null;
  className?: string;
  testId?: string;
}) {
  const [shown, setShown] = useState(false);
  const accessibleName = orderNumber?.trim() ? `Show PIN for order ${orderNumber.trim()}` : 'Show PIN for the card';
  return (
    <span className={className} data-testid={testId}>
      {label}{' '}
      <span className="font-mono" data-testid={testId ? `${testId}-value` : undefined}>
        {shown ? pin : '••••'}
      </span>{' '}
      <button
        type="button"
        aria-pressed={shown}
        aria-label={accessibleName}
        onClick={() => setShown((s) => !s)}
        className="ml-1 text-[10px] font-semibold underline text-gray-600 hover:text-gray-900"
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}

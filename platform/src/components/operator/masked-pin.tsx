'use client';

import { useState } from 'react';

/**
 * A gift-card PIN on an OPERATOR / VENDOR screen: hidden ("••••") by default behind a per-row
 * "Show" toggle (aria-pressed). The state is local to the mounted row, so it re-hides on any
 * navigation / remount. The member's own orders page shows the PIN openly (they need it) and does
 * NOT use this.
 */
export function MaskedPin({
  pin,
  label = 'PIN',
  className,
  testId,
}: {
  pin: string;
  /** Visible label before the value (also names the toggle for screen readers). */
  label?: string;
  className?: string;
  testId?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className={className} data-testid={testId}>
      {label}{' '}
      <span className="font-mono" data-testid={testId ? `${testId}-value` : undefined}>
        {shown ? pin : '••••'}
      </span>{' '}
      <button
        type="button"
        aria-pressed={shown}
        aria-label={shown ? `Hide ${label}` : `Show ${label}`}
        onClick={() => setShown((s) => !s)}
        className="ml-1 text-[10px] font-semibold underline text-gray-600 hover:text-gray-900"
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}

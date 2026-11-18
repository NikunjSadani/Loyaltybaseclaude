import React from 'react';
import Link from 'next/link';

/**
 * K2 — an outlet card that links to its KYC when there is one the caller can open, and renders as a plain
 * (non-navigating) block when the owner's KYC was filed via another outlet this caller cannot open
 * (`href === null`; the card then shows "KYC filed via outlet <code>"). Never a dead link.
 */
export function KycCardLink({
  href,
  className,
  children,
}: {
  href: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  if (href) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <div className={className} aria-disabled="true" data-testid="kyc-card-no-link">
      {children}
    </div>
  );
}

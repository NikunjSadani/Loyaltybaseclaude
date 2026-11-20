import React from 'react';
import Link, { LinkPendingHint } from '@/components/navigation/no-prefetch-link';

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
      // Not prefetched (a long list re-prefetched every visible outlet on each navigation); the hint dims the
      // tapped card at once and app/sales/kyc/[id]/loading.tsx shows the detail skeleton.
      <Link href={href} className={`relative ${className ?? ''}`}>
        {children}
        <LinkPendingHint />
      </Link>
    );
  }
  return (
    <div className={className} aria-disabled="true" data-testid="kyc-card-no-link">
      {children}
    </div>
  );
}

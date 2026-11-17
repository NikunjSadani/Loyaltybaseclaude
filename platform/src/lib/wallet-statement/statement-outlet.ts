/**
 * Which outlet a downloaded wallet statement names — the name and the code on the document must
 * ALWAYS be the same outlet.
 *
 * GET /api/wallet/statement resolves its outletCode AND outletName from the same active-partner
 * outlet row, so when the response carries a name it is used as-is with the response's code. The
 * shell identity (usePartnerIdentity) is NOT trusted by default: while /partner/me is pending, or after
 * it failed, it holds the stored/seeded login outlet — which after a sibling switch is a DIFFERENT
 * outlet than the statement's. It is only a fallback when the response has no name (an older
 * backend, or a partner with no outlet), and only once a successful /partner/me has confirmed the
 * identity AND (when the statement names a code) its active outlet carries that same code.
 * Otherwise the download is refused rather than produce a mixed-outlet statement.
 */
import type { PartnerIdentity } from '@/lib/partner-identity';

export class StatementOutletUnconfirmedError extends Error {
  constructor() {
    super('statement outlet not confirmed yet');
    this.name = 'StatementOutletUnconfirmedError';
  }
}

type IdentityForStatement = Pick<
  PartnerIdentity,
  'resolved' | 'outletName' | 'businessName' | 'operableOutlets' | 'activePartnerId'
>;

export function statementOutlet(
  api: { outletCode?: unknown; outletName?: unknown },
  identity: IdentityForStatement,
): { outletName: string; outletCode: string } {
  const outletCode = typeof api.outletCode === 'string' ? api.outletCode : '';
  if (typeof api.outletName === 'string' && api.outletName.trim()) {
    return { outletName: api.outletName, outletCode };
  }

  // Fallback: the shell identity — only when /partner/me SUCCEEDED for the current selection.
  if (identity.resolved !== true) throw new StatementOutletUnconfirmedError();
  if (outletCode) {
    const outlets = Array.isArray(identity.operableOutlets) ? identity.operableOutlets : [];
    if (outlets.length > 0) {
      const active = outlets.find((o) =>
        identity.activePartnerId ? o.partnerId === identity.activePartnerId : o.isOwnLogin,
      );
      if (!active || active.outletCode !== outletCode) throw new StatementOutletUnconfirmedError();
    }
  }
  return { outletName: identity.outletName || identity.businessName || '', outletCode };
}

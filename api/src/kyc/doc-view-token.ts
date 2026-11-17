import type { JwtService } from '@nestjs/jwt';

/** Lifetime of a signed KYC document-view link (Outlet Master doc columns). */
export const DOC_VIEW_TOKEN_TTL = '30d';

/**
 * Mint the 30-day, single-document view token verified by `GET /v1/kyc/documents/view?token=` (KycService.viewDocument):
 * `{ sub: <kycDocumentId>, clientId, typ: 'docview' }`, HMAC-signed with JWT_SECRET. The ONE implementation —
 * KycService.signDocViewToken delegates here, and the Outlet Master export kind calls it directly (the exports worker
 * job does not load KycModule's notification dependencies just to sign a link).
 */
export function mintDocViewToken(jwt: JwtService, secret: string | undefined, docId: string, clientId: string): string {
  return jwt.sign({ sub: docId, clientId, typ: 'docview' }, { secret, expiresIn: DOC_VIEW_TOKEN_TTL });
}

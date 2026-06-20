/**
 * SiteFooter — the "Powered by Gifsy" vendor credit.
 *
 * Gifsy is the white-label operator; the tenant (e.g. Deoleo) is the client. This
 * credit appears on the tenant-facing surfaces (login + admin/partner/sales portals),
 * NOT the Gifsy operator portal (where it would be redundant).
 *
 * No hooks — safe in both server and client layouts. Kept deliberately subtle.
 * (Future: the label could be made tenant-configurable via the SSR-branding work.)
 */
export function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`mt-8 text-center text-xs text-gray-400 ${className}`}>
      Powered by <span className="font-semibold text-gray-500">Gifsy</span>
    </footer>
  );
}

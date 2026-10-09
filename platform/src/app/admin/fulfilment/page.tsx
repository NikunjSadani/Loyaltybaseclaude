/**
 * /admin/fulfilment — Employee-Rewards fulfilment console (operator-facing).
 *
 * Reuses the trade gift-dispatch console (`/admin/gift-orders`) verbatim — same list,
 * filters, bulk sheet and status transitions. The console's data endpoints
 * (`GET/POST /api/admin/gift-orders...`, `/api/admin/rewards/fulfilment/...`) are already
 * account-scoped on the backend, so they now return employee orders too; `partnerName`
 * carries the EMPLOYEE's name for employee orders, hence the neutral "Recipient" column
 * label. Scope is handled server-side — this page only re-labels the shared console.
 */
import GiftOrdersConsolePage from '@/app/admin/gift-orders/page';

export default function Page() {
  return (
    <GiftOrdersConsolePage
      recipientColumnLabel="Recipient"
      title="Fulfilment"
      subtitle="Track and fulfil gift redemption orders — set the channel, logistics partner and tracking, and advance each order’s status."
    />
  );
}

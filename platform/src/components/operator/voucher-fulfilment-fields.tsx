'use client';

import { Ticket } from 'lucide-react';
import type { FulfilmentDraft } from '@/lib/gift-orders';
import { MaskedPin } from './masked-pin';

/**
 * The voucher half of the operator / vendor fulfilment form (admin/gift-orders/[id] and
 * vendor/orders/[id]) — ONE implementation of the lock rules the backend enforces:
 *  - once a code is STORED it is shown read-only (only "Voucher cancelled with vendor" clears it);
 *    the locked value is always read from the STORED order, never the draft (a channel round-trip
 *    can't blank it);
 *  - a stored PIN is read-only and masked behind "Show";
 *  - the set-once "Add the PIN for this card" box appears ONLY when the server would accept it —
 *    `fillable` (server-computed `voucherFillable`: paid, CONFIRMED…DELIVERED, not Hubble, not
 *    cash). Otherwise there is no PIN box for a stored code;
 *  - with no stored code, the code + optional PIN are entered together (the backend checks status).
 * Labels: "Card no. / code" and "PIN (if the card has one)".
 */
export function VoucherFulfilmentFields({
  storedCode,
  storedPin,
  orderNumber,
  fillable = false,
  draft,
  set,
  inputCls,
}: {
  storedCode?: string | null;
  storedPin?: string | null;
  /** Names the PIN "Show" toggle for screen readers. */
  orderNumber?: string | null;
  /** Server: a set-once PIN may still be added to the stored code (GiftOrderDetail.voucherFillable). */
  fillable?: boolean;
  draft: FulfilmentDraft;
  set: <K extends keyof FulfilmentDraft>(k: K, v: FulfilmentDraft[K]) => void;
  inputCls: string;
}) {
  const code = storedCode?.trim() ? storedCode.trim() : null;
  const pin = storedPin?.trim() ? storedPin.trim() : null;
  // No PIN box for a stored code the server would not take a PIN on.
  const pinBox = !pin && (!code || fillable);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="space-y-1 sm:col-span-2">
        {code ? (
          <>
            <span className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
              <Ticket className="w-3.5 h-3.5 text-amber-500" /> Card no. / code
            </span>
            <p className="text-sm font-mono text-gray-900 px-3 py-2 break-all" data-testid="ff-voucher-code-readonly">
              {code}
            </p>
          </>
        ) : (
          <>
            <label className="text-xs font-medium text-gray-700 flex items-center gap-1.5" htmlFor="ff-voucher-code">
              <Ticket className="w-3.5 h-3.5 text-amber-500" /> Card no. / code
            </label>
            <input
              id="ff-voucher-code"
              value={draft.voucherCode}
              onChange={(e) => set('voucherCode', e.target.value)}
              placeholder="AMZ-XXXX-XXXX"
              data-testid="ff-voucher-code"
              className={inputCls}
            />
          </>
        )}
      </div>
      <div className="space-y-1">
        {pin ? (
          <>
            <span className="text-xs font-medium text-gray-700">PIN (if the card has one)</span>
            <p className="text-sm text-gray-900 px-3 py-2">
              <MaskedPin pin={pin} orderNumber={orderNumber} testId="ff-voucher-pin-readonly" />
            </p>
          </>
        ) : pinBox ? (
          <>
            <label className="text-xs font-medium text-gray-700" htmlFor="ff-voucher-pin">
              PIN (if the card has one)
            </label>
            <input
              id="ff-voucher-pin"
              value={draft.voucherPin}
              onChange={(e) => set('voucherPin', e.target.value)}
              maxLength={64}
              autoComplete="off"
              aria-describedby={code ? 'ff-voucher-pin-hint' : undefined}
              data-testid="ff-voucher-pin"
              className={inputCls}
            />
            {code && (
              <p id="ff-voucher-pin-hint" className="text-[11px] text-gray-500">
                Add the PIN for this card — it can be saved once
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KYC_REJECTION_REASONS, buildRejectionReason } from '@/lib/kyc-rejection-reasons';

/**
 * Senior-reject remarks sheet for the sales KYC detail page.
 *
 * Lives in its own file (NOT exported from `page.tsx`): a Next.js page module may
 * only export `default` + reserved metadata names, so a stray component export trips
 * the strict page-type validator under `next build --webpack`.
 *
 * Reasons are SELECTED (not free-typed) to minimise open text entry. The ticked
 * presets + an optional "Others" note are joined into ONE string for the existing
 * `{ reason }` reject payload — onConfirm still receives a single string.
 */
export function RejectionModal({
  onConfirm, onCancel,
}: {
  onConfirm: (remarks: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [othersChecked, setOthersChecked] = useState(false);
  const [otherText, setOtherText] = useState('');

  const toggle = (reason: string) =>
    setSelected((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    );

  const canConfirm =
    (selected.length > 0 || othersChecked) &&
    (!othersChecked || otherText.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative w-full bg-white rounded-t-2xl p-5 space-y-4">
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto" />
        <h3 className="text-base font-bold text-gray-900">Rejection Remarks</h3>
        <p className="text-xs text-gray-500">Select one or more reasons (or choose Others to type).</p>

        <div className="max-h-56 overflow-y-auto space-y-1.5">
          {KYC_REJECTION_REASONS.map((reason) => {
            const isOn = selected.includes(reason);
            return (
              <button
                key={reason}
                type="button"
                onClick={() => toggle(reason)}
                aria-pressed={isOn}
                className={`w-full flex items-center gap-2.5 text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  isOn
                    ? 'border-red-400 bg-red-50 text-red-700'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span
                  className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center ${
                    isOn ? 'border-red-500 bg-red-500 text-white' : 'border-gray-300 bg-white'
                  }`}
                >
                  {isOn && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="flex-1">{reason}</span>
              </button>
            );
          })}

          {/* "Others" — toggles a free-text box for any reason not in the presets. */}
          <button
            type="button"
            onClick={() => setOthersChecked((v) => !v)}
            aria-pressed={othersChecked}
            className={`w-full flex items-center gap-2.5 text-left rounded-xl border px-3 py-2.5 text-sm transition-colors ${
              othersChecked
                ? 'border-red-400 bg-red-50 text-red-700'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <span
              className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center ${
                othersChecked ? 'border-red-500 bg-red-500 text-white' : 'border-gray-300 bg-white'
              }`}
            >
              {othersChecked && <Check className="h-3.5 w-3.5" />}
            </span>
            <span className="flex-1">Others</span>
          </button>
        </div>

        {othersChecked && (
          <textarea
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type the specific reason…"
            rows={3}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-red-400 resize-none"
          />
        )}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            className="flex-1 !bg-red-600 hover:!bg-red-700"
            disabled={!canConfirm}
            onClick={() =>
              canConfirm && onConfirm(buildRejectionReason(selected, othersChecked ? otherText : ''))
            }
          >
            Confirm Rejection
          </Button>
        </div>
      </div>
    </div>
  );
}

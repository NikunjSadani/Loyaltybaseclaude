import React from 'react';

export interface GenerateWarning {
  outletCode: string;
  reason: string;
}

/**
 * B-M3 — shown after "Generate invoices" when a regenerated invoice's GST no longer matches GST that was
 * ALREADY RELEASED to the retailer. That money has gone, so it is never changed automatically; the
 * operator must settle the difference. Shared by both generate screens so the message never drifts.
 */
export function GstReleaseWarnings({ warnings }: { warnings: GenerateWarning[] | undefined }) {
  if (!warnings?.length) return null;
  return (
    <div data-testid="generate-gst-warnings" role="alert" className="w-full bg-red-50 border border-red-200 rounded-lg p-3 text-left">
      <p className="text-[11px] font-semibold text-red-700 mb-1">
        {warnings.length} invoice{warnings.length !== 1 ? 's' : ''} need attention — GST already released does not match the regenerated invoice:
      </p>
      <ul className="space-y-0.5 max-h-40 overflow-y-auto">
        {warnings.map((w, i) => (
          <li key={i} className="text-[11px] text-gray-700 flex items-start gap-1.5">
            <span className="font-mono">{w.outletCode}</span>
            <span className="text-gray-400">—</span>
            <span>{w.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

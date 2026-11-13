'use client';

import { AlertTriangle } from 'lucide-react';
import { monthLabel, sentence } from '@/lib/sales-import/format';
import type { TargetUploadFocusCheck } from '@/lib/sales-import/types';

/**
 * FOCUS-FROM-TARGETS §7: focus product names in this file that will block applying sales for a month until fixed.
 * The upload itself already succeeded; this is an early warning (the month preview re-checks and is the one that
 * blocks). Nothing is shown when the check did not run (no "from the target file" KPI, or no product list yet).
 */
export function TargetFocusCheckNotice({ check }: { check: TargetUploadFocusCheck | undefined }) {
  if (!check || !check.checked) return null;
  const months = check.months.filter(m => m.blockers.length > 0);
  if (months.length === 0) return null;
  return (
    <div role="status" data-testid="target-focus-check" className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-2">
      {months.map(m => (
        <div key={m.month} className="space-y-1">
          <p className="text-xs font-semibold text-amber-800 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            These focus product names will block applying sales for {monthLabel(m.month)} until fixed:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            {m.blockers.map((b, i) => (
              <li key={`${b.code}-${b.kpiCode}-${b.key ?? i}`} className="text-xs text-amber-800">
                {sentence(b.message)}. ({b.outlets.toLocaleString('en-IN')} outlet{b.outlets === 1 ? '' : 's'})
                {b.sampleOutletCodes.length > 0 && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-[11px] underline decoration-dotted">Show outlet codes</summary>
                    <p className="mt-1 font-mono text-[11px] break-words">{b.sampleOutletCodes.join(', ')}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-[11px] text-amber-700">
        Your targets were saved. Fix the names in the file and upload it again — or, for a product that simply has not
        sold yet, accept it in the sales month preview.
      </p>
    </div>
  );
}

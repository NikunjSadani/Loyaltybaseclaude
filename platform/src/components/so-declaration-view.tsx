'use client';

/* ─── SoDeclarationView ─────────────────────────────────────────────────────────────
   On-screen WYSIWYG of the SO declaration — the exact text that is saved as the PDF.
   Rendered to the rep (at submission, SO-signed), the ASM (at first-approve), and Gifsy
   (final review, dual-signed). Styled to the prototype's "deed" (serif body, highlighted
   filled-in values, two-column signature block). Feature-gated at every call site.
─────────────────────────────────────────────────────────────────────────────── */

import {
  declarationSegments, formatDeclarationDate, BCCL_ADDRESS_LINES, asmDesignationOf, type SoDeclarationData,
} from '@/lib/so-declaration';

export function SoDeclarationView({
  data,
  signed = {},
  className = '',
}: {
  data: SoDeclarationData;
  /** Which signature lines are filled in. */
  signed?: { so?: boolean; asm?: boolean };
  className?: string;
}) {
  const paras = declarationSegments(data);
  const date = formatDeclarationDate(data.verificationDate);
  return (
    <div
      data-testid="so-declaration-view"
      className={`rounded-xl border border-gray-200 bg-white p-4 text-[12.5px] leading-relaxed text-gray-900 ${className}`}
      style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
    >
      <div className="text-[11.5px] text-gray-500 mb-3">
        To,
        {BCCL_ADDRESS_LINES.map((l) => (
          <span key={l} className="block">{l}</span>
        ))}
      </div>

      {paras.map((p, i) => (
        <p key={i} className="mb-2.5">
          {p.map((s, j) =>
            s.v ? (
              <span
                key={j}
                className="rounded px-1 font-semibold"
                style={{ background: '#dcfce7', color: '#14532d', fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: '12px' }}
              >
                {s.t}
              </span>
            ) : (
              <span key={j}>{s.t}</span>
            ),
          )}
        </p>
      ))}

      <div className="flex gap-4 flex-wrap mt-4">
        <div className="flex-1 min-w-[140px] border-t border-gray-400 pt-1.5" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
          <div className="h-6 flex items-end mb-0.5 text-[15px] italic" style={{ fontFamily: 'Georgia, serif' }}>
            {signed.so
              ? <span className="text-gray-900">{data.soName || '—'}</span>
              : <span className="text-amber-600 text-[11px] not-italic">awaiting signature</span>}
          </div>
          <span className="text-[11px] text-gray-500">Initiated by (Sales Officer) · {signed.so ? date : '—'}</span>
        </div>
        <div className="flex-1 min-w-[140px] border-t border-gray-400 pt-1.5" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
          <div className="h-6 flex items-end mb-0.5 text-[15px] italic" style={{ fontFamily: 'Georgia, serif' }}>
            {signed.asm
              ? <span className="text-gray-900">{data.asmName || '—'}</span>
              : <span className="text-amber-600 text-[11px] not-italic">awaiting ASM signature</span>}
          </div>
          <span className="text-[11px] text-gray-500">Approved by ({asmDesignationOf(data)}) · {signed.asm ? date : '—'}</span>
        </div>
      </div>
    </div>
  );
}

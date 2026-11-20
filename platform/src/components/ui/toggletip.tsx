'use client';

/**
 * Toggletip — a small "i" button that shows a plain-words definition on click / tap / Enter / Space, and hides on
 * Escape or a second press. Unlike a `title` tooltip it works with a keyboard and on touch screens, and the text is
 * announced to screen readers (a polite live region that is filled only while open).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export function Toggletip({ label, text, className }: { label: string; text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
    };
  }, [open]);

  return (
    <span ref={ref} className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="p-0.5 rounded text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
      >
        <Info className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <span id={id} role="status" aria-live="polite">
        {open && (
          <span className="absolute z-20 left-0 top-full mt-1 w-56 rounded-lg border border-gray-200 bg-white p-2 text-[11px] font-normal leading-snug text-gray-700 shadow-lg">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}

export default Toggletip;

'use client';

/* ─── SignaturePad ────────────────────────────────────────────────────────────────
   A self-contained draw-to-sign canvas pad, matching the look + mechanics of the KYC
   enrollment owner-signature pad (new/page.tsx): a fixed 600×120 bitmap stretched by CSS,
   pointer coordinates mapped from CSS px into bitmap px, and an opaque-white export so the
   PNG is self-visible on any background. Used for the SO (declaration, submission) and ASM
   (first-approve) signatures in the SO Declaration KYC variant.
─────────────────────────────────────────────────────────────────────────────── */

import {
  forwardRef, useImperativeHandle, useRef, useState, type MouseEvent, type TouchEvent,
} from 'react';
import { X } from 'lucide-react';

export interface SignaturePadHandle {
  /** Composited-over-white PNG data URL, or null when nothing has been drawn. */
  getDataUrl: () => string | null;
  clear: () => void;
  isEmpty: () => boolean;
}

interface SignaturePadProps {
  /** Fires with the inked state whenever it changes (enables the parent's gate). */
  onInkedChange?: (inked: boolean) => void;
  ariaLabel?: string;
  /** Hint shown faint in the empty pad. */
  placeholder?: string;
  className?: string;
}

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(function SignaturePad(
  { onInkedChange, ariaLabel = 'Signature pad — draw your signature here', placeholder = 'Sign here', className },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasSigned, setHasSigned] = useState(false);

  const setInked = (v: boolean) => {
    setHasSigned(v);
    onInkedChange?.(v);
  };

  const pos = (canvas: HTMLCanvasElement, e: MouseEvent | TouchEvent) => {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width ? canvas.width / rect.width : 1;
    const sy = rect.height ? canvas.height / rect.height : 1;
    if ('touches' in e && e.touches.length > 0) {
      return { x: (e.touches[0].clientX - rect.left) * sx, y: (e.touches[0].clientY - rect.top) * sy };
    }
    const me = e as MouseEvent;
    return { x: (me.clientX - rect.left) * sx, y: (me.clientY - rect.top) * sy };
  };

  const start = (e: MouseEvent<HTMLCanvasElement> | TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawing.current = true;
    const p = pos(canvas, e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  const move = (e: MouseEvent<HTMLCanvasElement> | TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const p = pos(canvas, e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1A1A2E';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    if (!hasSigned) setInked(true);
  };

  const end = () => { drawing.current = false; };

  useImperativeHandle(ref, () => ({
    isEmpty: () => !hasSigned,
    clear: () => {
      const canvas = canvasRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      setInked(false);
    },
    getDataUrl: () => {
      const src = canvasRef.current;
      if (!src || !hasSigned) return null;
      // Composite the near-black strokes over opaque white so the exported PNG is
      // self-visible everywhere (the live pad is transparent).
      const flat = document.createElement('canvas');
      flat.width = src.width;
      flat.height = src.height;
      const fctx = flat.getContext('2d');
      if (!fctx) return src.toDataURL('image/png');
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(0, 0, flat.width, flat.height);
      fctx.drawImage(src, 0, 0);
      return flat.toDataURL('image/png');
    },
  }), [hasSigned]);

  return (
    <div className={className}>
      <div className={`relative rounded-xl border-2 overflow-hidden transition-colors ${
        hasSigned ? 'border-[var(--brand-primary)]/40' : 'border-dashed border-gray-300'
      }`}>
        {!hasSigned && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-gray-300 font-medium select-none">{placeholder}</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={600}
          height={120}
          role="img"
          aria-label={ariaLabel}
          className="w-full touch-none bg-white cursor-crosshair"
          style={{ height: '120px' }}
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={end}
        />
      </div>
    </div>
  );
});

/** A Clear button styled to match the KYC pads; wire to a SignaturePadHandle ref. */
export function SignatureClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="text-[11px] font-semibold text-red-500 hover:text-red-700 flex items-center gap-1 transition-colors"
    >
      <X className="h-3 w-3" /> Clear
    </button>
  );
}

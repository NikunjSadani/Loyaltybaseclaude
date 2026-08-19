'use client';

/* ─── RBAC Option-X P6 — AccessDenied panel ────────────────────────────────────
   The page-level fallback shown to a GIFSY_STAFF operator who navigates to an
   admin route their role doesn't permit. It is a CLEAR message — not a raw error,
   and not a hidden nav item: the item stays visible, and accessing it lands here.

   Dark idiom matches the admin shell sidebar (bg #1A1A2E / panel #16213E).
─────────────────────────────────────────────────────────────────────────────── */

import { ShieldAlert } from 'lucide-react';

export interface AccessDeniedProps {
  /** Optional override for the body copy (defaults to the standard staff message). */
  message?: string;
}

export function AccessDenied({ message }: AccessDeniedProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-1 items-center justify-center py-16 px-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#1A1A2E] text-slate-200 border border-slate-700 shadow-xl px-8 py-10 text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#16213E]">
          <ShieldAlert className="h-7 w-7 text-amber-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">
          You don&apos;t have permission to access this
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          {message ?? "Your role doesn't include access to this page. Ask your admin to grant it."}
        </p>
      </div>
    </div>
  );
}

export default AccessDenied;

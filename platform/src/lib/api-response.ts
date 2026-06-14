import { NextResponse } from 'next/server';

/* ─── Shared API response helpers ─────────────────────────────────────────────
   The single server-side source of the `{ success, data }` / `{ success, error }`
   envelope that every API route returns and `lib/api-client.ts` expects on the
   client. Replaces the ~100 per-route `const ok = … / const err = …` copies.

   Use in route handlers:
     import { ok, err } from '@/lib/api-response'
     return ok(wallet)               // 200 { success: true, data: wallet }
     return err('Not found', 404)    // 404 { success: false, error: 'Not found' }

   The body shape MUST stay in sync with `ApiResponse<T>` in lib/api-client.ts.
─────────────────────────────────────────────────────────────────────────────── */

/** 200-style success envelope: `{ success: true, data }`. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/** Error envelope: `{ success: false, error }`. Defaults to HTTP 400. */
export function err(message: string, status = 400): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}

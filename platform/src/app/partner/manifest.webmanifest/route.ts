import { NextResponse } from 'next/server';
import { getTenantConfig } from '@/lib/platform/server';
import { buildManifest } from '@/lib/pwa/manifest';

/**
 * Per-tenant Web App Manifest for the Partner portal — served at
 * `/partner/manifest.webmanifest`.
 *
 * Explicit Route Handler (the nested `manifest` metadata-file convention is not
 * recognised — only `app/manifest.ts` at the root is). Request-dynamic per tenant
 * via getTenantConfig() → headers(). Scoped to /partner.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = await getTenantConfig();
  const manifest = buildManifest(config, 'partner');
  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

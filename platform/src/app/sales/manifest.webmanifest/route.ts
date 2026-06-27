import { NextResponse } from 'next/server';
import { getTenantConfig } from '@/lib/platform/server';
import { buildManifest } from '@/lib/pwa/manifest';

/**
 * Per-tenant Web App Manifest for the Sales portal — served at
 * `/sales/manifest.webmanifest`.
 *
 * Implemented as an explicit Route Handler (NOT the `manifest` metadata-file
 * convention, which is only recognised at the app ROOT — a nested
 * `app/sales/manifest.ts` 404s). Reads the resolved tenant via headers() inside
 * getTenantConfig(), so it is request-dynamic and each tenant gets its own
 * branded, installable Sales app scoped to /sales. The proxy lets `*.webmanifest`
 * through without auth (browser fetches it with credentials:omit).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = await getTenantConfig();
  const manifest = buildManifest(config, 'sales');
  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * GET /api/admin/settings/config
 *
 * Returns the current tenant's branding and feature flags, sourced via the
 * DB-backed getTenantConfig() loader (with registry fallback).
 *
 * Auth: GIFSY_ADMIN or CLIENT_ADMIN only.
 *
 * NEVER exposes secrets:
 *  - notifications.msg91AuthKey — always omitted
 *  - invoicing bank fields — always omitted
 *  - Only branding + features (+ non-secret metadata) are returned.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { getTenantConfig } from '@/lib/platform/server';

const ok = (data: unknown, status = 200) =>
  NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: message }, { status });

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const config = await getTenantConfig();

    // Return only non-secret public config blocks.
    // NEVER include: notifications.msg91AuthKey, invoicing bank fields.
    return ok({
      slug:         config.slug,
      internalName: config.internalName,
      status:       config.status,
      onboardedAt:  config.onboardedAt,
      branding:     config.branding,
      features:     config.features,
    });
  } catch (e: unknown) {
    console.error('[admin/settings/config GET]', e);
    return err('Failed to fetch tenant config', 500);
  }
}

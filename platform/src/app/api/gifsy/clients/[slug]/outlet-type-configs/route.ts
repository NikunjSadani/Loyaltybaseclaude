/**
 * GET  /api/gifsy/clients/[slug]/outlet-type-configs
 *   Returns all outlet type configs for a client (GIFSY_ADMIN only).
 *   Missing rows are returned with all-default values.
 *
 * PUT  /api/gifsy/clients/[slug]/outlet-type-configs/[code]
 *   Upserts config for one outlet type (GIFSY_ADMIN only).
 *   Only fields present in the body are updated; others are unchanged.
 *
 * Note: CLIENT_ADMIN access to their own tenant is intentionally deferred
 * until the platform frontend has a proper session/JWT for admin users.
 * For now only GIFSY_ADMIN (platform super-admin) can use these routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (data: unknown) => NextResponse.json({ success: true,  data  });
const err = (msg: string, status = 400) =>
  NextResponse.json({ success: false, error: msg }, { status });

const ALLOWED_ROLES = new Set(['GIFSY_ADMIN']);

const DEFAULT_FLAGS = {
  isEnabled:          true,
  displayName:        null,
  loyaltyEnabled:     true,
  schemesEnabled:     true,
  visibilityEnabled:  true,
  payoutsEnabled:     true,
  leaderboardEnabled: true,
  targetsEnabled:     true,
  kycRequired:        true,
} as const;

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const user = getAuthUser(req);
  if (!user)                         return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.has(user.role)) return err('Forbidden', 403);

  const { slug } = await context.params;

  const [types, rows] = await Promise.all([
    prisma.outletType.findMany({
      where:   { isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.outletTypeClientConfig.findMany({ where: { clientId: slug } }),
  ]);

  const rowMap = new Map(rows.map((r: any) => [r.outletTypeId, r]));

  const data = types.map((type: any) => {
    const row = rowMap.get(type.id) as any;
    return {
      clientId:           slug,
      outletTypeCode:     type.code,
      outletTypeName:     type.name,
      isEnabled:          row?.isEnabled          ?? DEFAULT_FLAGS.isEnabled,
      displayName:        row?.displayName        ?? DEFAULT_FLAGS.displayName,
      loyaltyEnabled:     row?.loyaltyEnabled     ?? DEFAULT_FLAGS.loyaltyEnabled,
      schemesEnabled:     row?.schemesEnabled     ?? DEFAULT_FLAGS.schemesEnabled,
      visibilityEnabled:  row?.visibilityEnabled  ?? DEFAULT_FLAGS.visibilityEnabled,
      payoutsEnabled:     row?.payoutsEnabled     ?? DEFAULT_FLAGS.payoutsEnabled,
      leaderboardEnabled: row?.leaderboardEnabled ?? DEFAULT_FLAGS.leaderboardEnabled,
      targetsEnabled:     row?.targetsEnabled     ?? DEFAULT_FLAGS.targetsEnabled,
      kycRequired:        row?.kycRequired        ?? DEFAULT_FLAGS.kycRequired,
    };
  });

  return ok(data);
}


/**
 * PUT /api/gifsy/clients/[slug]/outlet-type-configs/[code]
 *
 * Upserts the feature flag config for one outlet type (identified by its
 * stable code, e.g. RETAILER) for the given client slug.
 *
 * Only supplied fields are updated — omitted flags retain their existing
 * value (or the all-true default if no row exists yet).
 *
 * GIFSY_ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';

const ok  = (data: unknown) => NextResponse.json({ success: true,  data  });
const err = (msg: string, status = 400) =>
  NextResponse.json({ success: false, error: msg }, { status });

const ALLOWED_ROLES = new Set(['GIFSY_ADMIN']);

const DEFAULT_FLAGS = {
  isEnabled:          true,
  displayName:        null as string | null,
  loyaltyEnabled:     true,
  schemesEnabled:     true,
  visibilityEnabled:  true,
  payoutsEnabled:     true,
  leaderboardEnabled: true,
  targetsEnabled:     true,
  kycRequired:        true,
};

export async function PUT(
  req:     NextRequest,
  context: { params: Promise<{ slug: string; code: string }> },
) {
  const user = getAuthUser(req);
  if (!user)                         return err('Unauthorized', 401);
  if (!ALLOWED_ROLES.has(user.role)) return err('Forbidden', 403);

  const { slug, code } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  // Resolve outlet type by code
  const outletType = await prisma.outletType.findFirst({
    where: { code, isActive: true },
  }) as any;

  if (!outletType) {
    return err(`Outlet type "${code}" not found.`, 404);
  }

  // Only apply fields that are explicitly present in the body
  const createData = { ...DEFAULT_FLAGS };
  const updateData: Record<string, unknown> = {};

  const fields = [
    'isEnabled', 'displayName',
    'loyaltyEnabled', 'schemesEnabled', 'visibilityEnabled',
    'payoutsEnabled', 'leaderboardEnabled', 'targetsEnabled', 'kycRequired',
  ] as const;

  for (const field of fields) {
    if (field in body) {
      (createData as any)[field]  = body[field];
      updateData[field]           = body[field];
    }
  }

  const row = await prisma.outletTypeClientConfig.upsert({
    where: {
      clientId_outletTypeId: { clientId: slug, outletTypeId: outletType.id },
    },
    create: { clientId: slug, outletTypeId: outletType.id, ...createData },
    update: updateData,
  }) as any;

  return ok({
    clientId:           row.clientId,
    outletTypeCode:     outletType.code,
    outletTypeName:     outletType.name,
    isEnabled:          row.isEnabled,
    displayName:        row.displayName,
    loyaltyEnabled:     row.loyaltyEnabled,
    schemesEnabled:     row.schemesEnabled,
    visibilityEnabled:  row.visibilityEnabled,
    payoutsEnabled:     row.payoutsEnabled,
    leaderboardEnabled: row.leaderboardEnabled,
    targetsEnabled:     row.targetsEnabled,
    kycRequired:        row.kycRequired,
  });
}

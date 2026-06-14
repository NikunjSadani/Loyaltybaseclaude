import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);

    if (process.env.DEMO_MODE === 'true') {
      return ok({ outlets: [] });
    }

    const outlets = await prisma.outlet.findMany({
      where: {
        deletedAt: null,
        partner: { user: { clientId } },
      },
      select: {
        outletCode:   true,
        name:         true,
        outletTypeId: true,
        city:         true,
        state:        true,
        isActive:     true,
        createdAt:    true,
        partner: {
          select: { partnerCode: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = outlets.map(o => ({
      outletId:        o.outletCode,
      outletName:      o.name,
      outletType:      o.outletTypeId,
      programName:     '',
      programCategory: '',
      beat:            '',
      distributorId:   o.partner?.partnerCode ?? '',
      city:            o.city,
      state:           o.state,
      metro:           false,
      xsrId:           '',
      xsrName:         '',
      kycStatus:       'NOT_STARTED',
      isActive:        o.isActive,
      addedDate:       o.createdAt.toISOString().slice(0, 10),
    }));

    return ok({ outlets: mapped });
  } catch (e: any) {
    console.error('[admin/outlets GET]', e);
    return err('Failed to fetch outlets', 500);
  }
}

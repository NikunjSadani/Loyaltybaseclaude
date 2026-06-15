import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const ADMIN_ROLES = new Set(['GIFSY_ADMIN', 'CLIENT_ADMIN']);

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (!ADMIN_ROLES.has(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string },'partners:manage_outlets');
    if (denied) return denied;

    if (process.env.DEMO_MODE === 'true') {
      return ok({ outlets: [] });
    }

    // Scope by the outlet's OWN clientId — an outlet uploaded via the master file
    // has no partner until KYC, so it must not be reached via the partner relation.
    const outlets = await prisma.outlet.findMany({
      where: {
        deletedAt: null,
        clientId,
      },
      select: {
        outletCode:      true,
        name:            true,
        outletTypeId:    true,
        city:            true,
        state:           true,
        isActive:        true,
        createdAt:       true,
        distributorCode: true,
        beat:            true,
        metro:           true,
        programName:     true,
        programCategory: true,
        // Active XSR assignment (the sales rep covering this outlet).
        salesAssignments: {
          where:   { unassignedAt: null },
          take:    1,
          orderBy: { assignedAt: 'desc' },
          select: {
            salesUser: {
              select: { employeeCode: true, user: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const mapped = outlets.map(o => {
      const xsr = o.salesAssignments[0]?.salesUser;
      return {
        outletId:        o.outletCode,
        outletName:      o.name,
        outletType:      o.outletTypeId,
        programName:     o.programName ?? '',
        programCategory: o.programCategory ?? '',
        beat:            o.beat ?? '',
        distributorId:   o.distributorCode ?? '',
        city:            o.city,
        state:           o.state,
        metro:           !!(o.metro && o.metro.trim()),
        xsrId:           xsr?.employeeCode ?? '',
        xsrName:         xsr?.user?.name ?? '',
        kycStatus:       'NOT_STARTED',
        isActive:        o.isActive,
        addedDate:       o.createdAt.toISOString().slice(0, 10),
      };
    });

    return ok({ outlets: mapped });
  } catch (e: any) {
    console.error('[admin/outlets GET]', e);
    return err('Failed to fetch outlets', 500);
  }
}

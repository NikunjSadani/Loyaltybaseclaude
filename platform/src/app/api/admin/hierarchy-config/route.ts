import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';
import { persistHierarchy } from '@/lib/hierarchy-persistence';
import { DEOLEO_HIERARCHY } from '@/lib/employee-hierarchy';
import type { HierarchyEmployee } from '@/types';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'employee_hierarchy';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string },'sales_org:read');
    if (denied) return denied;

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const employees = (setting?.settingValue as unknown[]) ?? [];

    return ok({ employees });
  } catch (e: any) {
    console.error('[admin/hierarchy-config GET]', e);
    return err('Failed to fetch employee hierarchy', 500);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string },'sales_org:manage_hierarchy');
    if (denied) return denied;
    const body = await req.json();
    const employees = body?.employees;

    if (!Array.isArray(employees)) return err('Expected { employees: [...] }');

    // 1. Keep the denormalized JSON snapshot for the current admin UI (GET).
    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: employees as any, updatedById: authUser.userId },
      create: { clientId, settingKey: SETTING_KEY, settingValue: employees as any, updatedById: authUser.userId },
    });

    // 2. Persist the authoritative relational tree (levels + Users + SalesUsers)
    //    so downstream validation (outlet XSR check) and /sales/team read real data.
    const result = await persistHierarchy(
      clientId,
      employees as HierarchyEmployee[],
      DEOLEO_HIERARCHY,
      prisma,
    );

    return ok({ message: 'Employee hierarchy saved', persisted: result });
  } catch (e: any) {
    console.error('[admin/hierarchy-config PUT]', e);
    return err('Failed to save employee hierarchy', 500);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';
import { requirePermission } from '@/lib/rbac/require-permission';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'kpi_defs';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const denied = await requirePermission(authUser as { role: string; clientId: string },'reports:read');
    if (denied) return denied;

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const kpiDefs = (setting?.settingValue as unknown[]) ?? [];

    return ok({ kpiDefs });
  } catch (e: any) {
    console.error('[admin/kpi-config GET]', e);
    return err('Failed to fetch KPI definitions', 500);
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
    const denied = await requirePermission(authUser as { role: string; clientId: string },'reports:manage_scheduled');
    if (denied) return denied;
    const body = await req.json();

    if (!Array.isArray(body)) return err('Expected an array of KPI definitions');

    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: body as any, updatedById: authUser.userId },
      create: { clientId, settingKey: SETTING_KEY, settingValue: body as any, updatedById: authUser.userId },
    });

    return ok({ message: 'KPI definitions saved' });
  } catch (e: any) {
    console.error('[admin/kpi-config PUT]', e);
    return err('Failed to save KPI definitions', 500);
  }
}

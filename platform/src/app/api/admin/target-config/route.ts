import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'target_configs';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const configs = (setting?.settingValue as unknown[]) ?? [];

    return ok({ configs });
  } catch (e: any) {
    console.error('[admin/target-config GET]', e);
    return err('Failed to fetch target configs', 500);
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
    const cfg = await req.json();

    if (!cfg || typeof cfg !== 'object' || !cfg.id) {
      return err('Expected a TargetConfig object with an id');
    }

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });
    const existing: any[] = (setting?.settingValue as any[]) ?? [];
    const idx = existing.findIndex((c: any) => c.id === cfg.id);
    if (idx >= 0) existing[idx] = cfg; else existing.unshift(cfg);

    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: existing as any, updatedById: authUser.userId },
      create: { clientId, settingKey: SETTING_KEY, settingValue: existing as any, updatedById: authUser.userId },
    });

    return ok({ message: 'Target config saved' });
  } catch (e: any) {
    console.error('[admin/target-config PUT]', e);
    return err('Failed to save target config', 500);
  }
}

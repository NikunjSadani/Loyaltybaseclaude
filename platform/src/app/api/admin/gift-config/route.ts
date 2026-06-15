import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'gift_catalogue';

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

    const gifts = (setting?.settingValue as unknown[]) ?? [];

    return ok({ gifts });
  } catch (e: any) {
    console.error('[admin/gift-config GET]', e);
    return err('Failed to fetch gift catalogue', 500);
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
    const body = await req.json();

    if (!Array.isArray(body)) return err('Expected an array of gift items');

    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: body as any, updatedById: authUser.userId },
      create: { clientId, settingKey: SETTING_KEY, settingValue: body as any, updatedById: authUser.userId },
    });

    return ok({ message: 'Gift catalogue saved' });
  } catch (e: any) {
    console.error('[admin/gift-config PUT]', e);
    return err('Failed to save gift catalogue', 500);
  }
}

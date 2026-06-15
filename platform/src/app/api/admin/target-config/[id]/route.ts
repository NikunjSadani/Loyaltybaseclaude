import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'target_configs';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const { id } = await params;

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });
    const existing: any[] = (setting?.settingValue as any[]) ?? [];
    const updated = existing.filter((c: any) => c.id !== id);

    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: updated as any, updatedById: authUser.userId },
      create: { clientId, settingKey: SETTING_KEY, settingValue: updated as any, updatedById: authUser.userId },
    });

    return ok({ message: 'Target config deleted' });
  } catch (e: any) {
    console.error('[admin/target-config DELETE]', e);
    return err('Failed to delete target config', 500);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { z }                         from 'zod';
import prisma                        from '@/lib/prisma';
import { getAuthUser }               from '@/lib/auth';
import { getClientIdFromRequest }    from '@/lib/tenant';
import { DEFAULT_TASK_CONFIG }       from '@/lib/task-config';

const SETTING_KEY = 'task_config';

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data },          { status });
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

const taskConfigSchema = z.object({
  customTaskLabel: z.string().min(1, 'Label is required'),
  customTaskItems: z.array(z.object({
    id:       z.string(),
    title:    z.string(),
    subtitle: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    startsAt: z.string().optional(),
    endsAt:   z.string().optional(),
  })),
});

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    // All authenticated users (admin + all sales roles) can read task config.
    // Partners (RETAILER / WHOLESALER / SUB_STOCKIST) are blocked.
    const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    if (partnerRoles.includes(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);
    const row = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const config = row ? (row.settingValue as object) : DEFAULT_TASK_CONFIG;
    return ok({ config });
  } catch (e: any) {
    console.error('[admin/task-config GET]', e);
    return err('Failed to fetch task config', 500);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const body     = await req.json();
    const parsed   = taskConfigSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.issues[0].message);

    const setting = await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: parsed.data, updatedById: authUser.userId },
      create: {
        settingKey:   SETTING_KEY,
        settingValue: parsed.data,
        category:     'sales_tasks',
        description:  'Sales dashboard task category configuration',
        updatedById:  authUser.userId,
        clientId,
      },
    });

    await prisma.auditLog.create({
      data: {
        action:     'UPDATE',
        entityType: 'PROGRAM_SETTINGS',
        entityId:   setting.id,
        actorId:    authUser.userId,
        metadata:   { key: SETTING_KEY },
      },
    });

    return ok({ config: parsed.data });
  } catch (e: any) {
    console.error('[admin/task-config PUT]', e);
    return err('Failed to save task config', 500);
  }
}

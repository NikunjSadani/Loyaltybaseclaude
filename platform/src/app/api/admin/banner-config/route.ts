import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

const SETTING_KEY = 'banner_config';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const bannerItemSchema = z.object({
  id:             z.string(),
  active:         z.boolean(),
  type:           z.enum(['text', 'video']),
  title:          z.string(),
  body:           z.string(),
  ctaLabel:       z.string(),
  ctaUrl:         z.string(),
  videoUrl:       z.string(),
  bgColor:        z.string(),
  audience:       z.enum(['ALL', 'SSS', 'WHOLESALER', 'SUB_STOCKIST']),
  priority:       z.number().int().min(0).default(0),
  startDate:      z.string().optional().default(''),
  endDate:        z.string().optional().default(''),
  showInSalesApp: z.boolean().default(false),
  updatedAt:      z.string(),
});

const bannerConfigSchema = z.object({
  banners: z.array(bannerItemSchema),
});

const popupItemSchema = z.object({
  id:        z.string(),
  active:    z.boolean(),
  type:      z.enum(['text', 'video', 'image']),
  title:     z.string(),
  body:      z.string(),
  imageUrl:  z.string(),
  videoUrl:  z.string(),
  ctaLabel:  z.string(),
  ctaUrl:    z.string(),
  bgColor:   z.string(),
  frequency: z.enum(['always', 'once', 'daily']),
  audience:  z.enum(['ALL', 'SSS', 'WHOLESALER', 'SUB_STOCKIST']),
  updatedAt: z.string(),
});

const fullConfigSchema = z.object({
  banners: z.array(bannerItemSchema),
  popups:  z.array(popupItemSchema).optional().default([]),
});

// Partner roles are NOT allowed to read the config (they are the audience, not the managers)
const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (partnerRoles.includes(authUser.role)) return err('Forbidden', 403);

    const clientId = getClientIdFromRequest(req);

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const config = (setting?.settingValue as any) ?? { banners: [], popups: [] };

    return ok({ banners: config.banners ?? [], popups: config.popups ?? [] });
  } catch (e: any) {
    console.error('[banner-config GET]', e);
    return err('Failed to fetch banner config', 500);
  }
}

// ─── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);
    if (authUser.role !== 'GIFSY_ADMIN' && authUser.role !== 'CLIENT_ADMIN') {
      return err('Forbidden', 403);
    }

    const clientId = getClientIdFromRequest(req);
    const body   = await req.json();
    const parsed = fullConfigSchema.safeParse(body);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? 'Invalid request body', 400);
    }

    const configValue = parsed.data;

    await prisma.programSetting.upsert({
      where:  { clientId_settingKey: { clientId, settingKey: SETTING_KEY } },
      update: { settingValue: configValue as any },
      create: { clientId, settingKey: SETTING_KEY, settingValue: configValue as any },
    });

    await prisma.auditLog.create({
      data: {
        actorId:    authUser.userId,
        action:     'UPDATE' as any,
        entityType: 'PROGRAM_SETTING',
        entityId:   SETTING_KEY,
        newValues:  configValue as any,
      },
    });

    return ok({ message: 'Banner config saved' });
  } catch (e: any) {
    console.error('[banner-config PUT]', e);
    return err('Failed to save banner config', 500);
  }
}

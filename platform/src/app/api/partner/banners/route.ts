import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data  }, { status });
const err = (msg: string,   status = 400) => NextResponse.json({ success: false, error: msg }, { status });

const SETTING_KEY = 'banner_config';

/**
 * GET /api/partner/banners
 *
 * Returns the active banner + popup config for the requesting partner.
 * All authenticated roles (including partners) may read this endpoint.
 * The admin write endpoint (PUT /api/admin/banner-config) remains restricted
 * to GIFSY_ADMIN / CLIENT_ADMIN only.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return err('Unauthorized', 401);

    const clientId = getClientIdFromRequest(req);

    const setting = await prisma.programSetting.findFirst({
      where: { clientId, settingKey: SETTING_KEY },
    });

    const config = (setting?.settingValue as any) ?? { banners: [], popups: [] };

    return ok({
      banners: config.banners ?? [],
      popups:  config.popups  ?? [],
    });
  } catch (e: any) {
    console.error('[partner/banners GET]', e);
    return err('Failed to fetch banners', 500);
  }
}

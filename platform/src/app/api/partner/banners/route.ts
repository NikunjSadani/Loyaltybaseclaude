import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAuthUser } from '@/lib/auth';
import { getClientIdFromRequest } from '@/lib/tenant';

const ok  = (data: unknown, status = 200) => NextResponse.json({ success: true, data  }, { status });
const err = (msg: string,   status = 400) => NextResponse.json({ success: false, error: msg }, { status });

const SETTING_KEY = 'banner_config';

// ── Development mock ──────────────────────────────────────────────────────────
// In local dev the Cloud SQL instance is unreachable (private VPC).
// Return a visible demo banner so UI can be developed/tested without a DB.
const DEV_MOCK_CONFIG = {
  banners: [
    {
      id: 'dev-banner-1',
      active: true,
      type: 'text',
      title: '5%',
      body: 'Buy 20 litres and get 5% off.',
      ctaLabel: '',
      ctaUrl: '',
      videoUrl: '',
      bgColor: 'navy',
      audience: 'ALL',
      priority: 0,
      startDate: '',
      endDate: '',
      showInSalesApp: true,
      updatedAt: new Date().toISOString(),
    },
  ],
  popups: [],
};

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

    let config: { banners: unknown[]; popups: unknown[] };

    try {
      const setting = await prisma.programSetting.findFirst({
        where: { clientId, settingKey: SETTING_KEY },
      });
      config = (setting?.settingValue as any) ?? { banners: [], popups: [] };
    } catch (dbErr: any) {
      // DB unreachable (e.g. local dev without Cloud SQL tunnel).
      // Fall back to a visible dev-mode banner so the UI can be tested.
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[partner/banners] DB unavailable in dev — returning mock banner');
        return ok(DEV_MOCK_CONFIG);
      }
      throw dbErr; // re-throw in production so the error is logged
    }

    return ok({
      banners: config.banners ?? [],
      popups:  config.popups  ?? [],
    });
  } catch (e: any) {
    console.error('[partner/banners GET]', e);
    return err('Failed to fetch banners', 500);
  }
}

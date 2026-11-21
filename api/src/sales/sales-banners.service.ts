import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

/** The ProgramSetting key the admin Banners screen writes (admin-programs/banner-config.service.ts). */
export const BANNER_SETTING_KEY = 'banner_config';

/** The fields the sales dashboard renders — nothing else from the stored blob is returned. */
export interface SalesBanner {
  id: string;
  type: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  videoUrl: string;
  bgColor: string;
  priority: number;
  startDate: string;
  endDate: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Today's IST calendar date, YYYY-MM-DD (banner start / end dates are plain calendar dates). */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Pure filter (owner 2026-11-21): ONLY banners with `active === true` AND `showInSalesApp === true`, in their date
 * window (inclusive; empty = no bound; IST calendar day), sorted by priority ascending (ties keep stored order).
 *
 * Audience: the partner `audience` (ALL / SSS / WHOLESALER / SUB_STOCKIST) is an OUTLET-type target for the partner
 * app; a sales rep covers every outlet type, so the sales app shows every `showInSalesApp` banner whatever its
 * audience. `showInSalesApp` is the sales switch.
 */
export function selectSalesBanners(raw: unknown, today: string): SalesBanner[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((b, i) => ({ b: (b ?? {}) as Record<string, unknown>, i }))
    .filter(({ b }) => {
      if (b.active !== true || b.showInSalesApp !== true) return false;
      const start = str(b.startDate);
      const end = str(b.endDate);
      if (start && today < start) return false;
      if (end && today > end) return false;
      return true;
    })
    .map(({ b, i }) => ({
      i,
      banner: {
        id: str(b.id),
        type: str(b.type) || 'text',
        title: str(b.title),
        body: str(b.body),
        ctaLabel: str(b.ctaLabel),
        ctaUrl: str(b.ctaUrl),
        videoUrl: str(b.videoUrl),
        bgColor: str(b.bgColor),
        priority: typeof b.priority === 'number' && Number.isFinite(b.priority) ? b.priority : 0,
        startDate: str(b.startDate),
        endDate: str(b.endDate),
      },
    }))
    .sort((x, y) => x.banner.priority - y.banner.priority || x.i - y.i)
    .map(({ banner }) => banner);
}

/**
 * GET /v1/sales/banners — the sales app's read path for strip banners (the partner read, /v1/partner/banners, is
 * partner-roles only). Own tenant only (JWT clientId); popups are never returned (they have no sales switch).
 * No banner config / no matching banner → `{ banners: [] }` (every tenant on prod today).
 */
@Injectable()
export class SalesBannersService {
  constructor(private readonly prisma: PrismaService) {}

  async getBanners(user: JwtPayload, now: Date = new Date()): Promise<{ banners: SalesBanner[] }> {
    // Never an unscoped read: `where: { clientId: undefined }` would match ANY tenant's row.
    if (!user?.clientId) return { banners: [] };
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: BANNER_SETTING_KEY },
      select: { settingValue: true },
    });
    const config = setting?.settingValue as { banners?: unknown } | null | undefined;
    return { banners: selectSalesBanners(config?.banners, istToday(now)) };
  }
}

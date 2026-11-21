import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpdateBannerConfigDto } from './dto/banner-config.dto';
import { isPartnerLoginRole } from '../partner/partner-display.helper';

const SETTING_KEY = 'banner_config';

/** A CTA link must be blank or an absolute http(s) URL (no javascript:, data:, relative or other schemes). */
export function isAllowedCtaUrl(url: unknown): boolean {
  if (url === undefined || url === null) return true;
  if (typeof url !== 'string') return false;
  const v = url.trim();
  if (!v) return true;
  if (/\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/** Every refused CTA link, worded for the admin ("Banner "Diwali" — button link …"). Empty = all fine. */
export function invalidCtaLinks(dto: { banners?: { title?: string; ctaUrl?: string }[]; popups?: { title?: string; ctaUrl?: string }[] }): string[] {
  const out: string[] = [];
  const check = (kind: string, items: { title?: string; ctaUrl?: string }[] | undefined) =>
    (items ?? []).forEach((it, i) => {
      if (!isAllowedCtaUrl(it?.ctaUrl)) {
        const name = (it?.title ?? '').trim() || `#${i + 1}`;
        out.push(`${kind} "${name}" — button link "${String(it?.ctaUrl ?? '').trim()}"`);
      }
    });
  check('Banner', dto.banners);
  check('Popup', dto.popups);
  return out;
}

/**
 * Banner Config admin — ported from
 * platform/src/app/api/admin/banner-config/route.ts.
 *
 * Config is a JSON blob (banners + popups) under the `banner_config`
 * ProgramSetting key (KEPT). Tenant-scoped by clientId.
 *
 * GET: engagement:read (partner roles SSS/WHOLESALER/SUB_STOCKIST blocked at controller).
 * PUT: GIFSY_ADMIN | CLIENT_ADMIN (engagement:manage_banners).
 */
@Injectable()
export class BannerConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/banner-config */
  async get(user: JwtPayload) {
    // Partner roles are the audience, not the managers — blocked from reading config.
    if (isPartnerLoginRole(user.role)) {
      throw new ForbiddenException('Forbidden');
    }
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: SETTING_KEY },
    });
    const config = (setting?.settingValue as { banners?: unknown[]; popups?: unknown[] } | null) ?? {
      banners: [],
      popups: [],
    };
    return { banners: config.banners ?? [], popups: config.popups ?? [] };
  }

  /** PUT /v1/admin/banner-config */
  async update(user: JwtPayload, dto: UpdateBannerConfigDto) {
    // Audit fix 2026-11-21: CTA links are rendered as <a href> in the partner + sales apps — only http(s) allowed.
    const bad = invalidCtaLinks(dto);
    if (bad.length) {
      throw new BadRequestException(
        `Button links must start with http:// or https:// (or be left blank). Fix: ${bad.join('; ')}.`,
      );
    }
    const configValue: Prisma.InputJsonValue = {
      banners: dto.banners as unknown as Prisma.InputJsonValue,
      popups: (dto.popups ?? []) as unknown as Prisma.InputJsonValue,
    };

    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: user.clientId, settingKey: SETTING_KEY } },
      update: { settingValue: configValue },
      create: { clientId: user.clientId, settingKey: SETTING_KEY, settingValue: configValue },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: user.sub,
        action: 'UPDATE',
        entityType: 'PROGRAM_SETTING',
        entityId: SETTING_KEY,
        newValues: configValue,
      },
    });

    return { message: 'Banner config saved' };
  }
}

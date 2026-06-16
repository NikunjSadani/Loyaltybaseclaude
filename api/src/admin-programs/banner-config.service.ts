import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpdateBannerConfigDto } from './dto/banner-config.dto';

const SETTING_KEY = 'banner_config';

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

  /** Partner roles are the audience, not the managers — blocked from reading config. */
  private static readonly PARTNER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];

  /** GET /v1/admin/banner-config */
  async get(user: JwtPayload) {
    if (BannerConfigService.PARTNER_ROLES.includes(user.role)) {
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

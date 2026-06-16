import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const SETTING_KEY = 'target_configs';

type TargetConfig = { id: string; [key: string]: unknown };

/**
 * Target Config admin — ported from
 * platform/src/app/api/admin/target-config/{route.ts,[id]/route.ts}.
 *
 * IMPORTANT: this does NOT reference the dropped `Target` model. Target configs
 * are stored as a JSON array under the `target_configs` ProgramSetting key
 * (KEPT). Tenant-scoped by clientId via the ProgramSetting unique key.
 *
 * GET allows GIFSY_ADMIN | CLIENT_ADMIN (targets:read).
 * PUT/DELETE allow GIFSY_ADMIN | CLIENT_ADMIN (targets:manage_config).
 */
@Injectable()
export class TargetConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/target-config */
  async list(user: JwtPayload) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: SETTING_KEY },
    });
    const configs = (setting?.settingValue as unknown[]) ?? [];
    return { configs };
  }

  /** PUT /v1/admin/target-config — upsert one config (by id) into the array. */
  async upsert(user: JwtPayload, cfg: unknown) {
    if (!cfg || typeof cfg !== 'object' || !(cfg as TargetConfig).id) {
      throw new BadRequestException('Expected a TargetConfig object with an id');
    }
    const config = cfg as TargetConfig;

    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: SETTING_KEY },
    });
    const existing: TargetConfig[] = (setting?.settingValue as TargetConfig[]) ?? [];
    const idx = existing.findIndex((c) => c.id === config.id);
    if (idx >= 0) existing[idx] = config;
    else existing.unshift(config);

    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: user.clientId, settingKey: SETTING_KEY } },
      update: { settingValue: existing as unknown as Prisma.InputJsonValue, updatedById: user.sub },
      create: {
        clientId: user.clientId,
        settingKey: SETTING_KEY,
        settingValue: existing as unknown as Prisma.InputJsonValue,
        updatedById: user.sub,
      },
    });

    return { message: 'Target config saved' };
  }

  /** DELETE /v1/admin/target-config/:id */
  async remove(user: JwtPayload, id: string) {
    const setting = await this.prisma.programSetting.findFirst({
      where: { clientId: user.clientId, settingKey: SETTING_KEY },
    });
    const existing: TargetConfig[] = (setting?.settingValue as TargetConfig[]) ?? [];
    const updated = existing.filter((c) => c.id !== id);

    await this.prisma.programSetting.upsert({
      where: { clientId_settingKey: { clientId: user.clientId, settingKey: SETTING_KEY } },
      update: { settingValue: updated as unknown as Prisma.InputJsonValue, updatedById: user.sub },
      create: {
        clientId: user.clientId,
        settingKey: SETTING_KEY,
        settingValue: updated as unknown as Prisma.InputJsonValue,
        updatedById: user.sub,
      },
    });

    return { message: 'Target config deleted' };
  }
}

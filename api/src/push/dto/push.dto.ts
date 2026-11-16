import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Platforms an installed-PWA beacon may report. */
export const PWA_PLATFORMS = ['ANDROID', 'IOS', 'DESKTOP', 'OTHER'] as const;
export type PwaPlatform = (typeof PWA_PLATFORMS)[number];

/** POST /v1/push/installed body. userId/clientId are taken from the JWT, NEVER here. */
export class ReportInstallDto {
  @IsIn(PWA_PLATFORMS)
  platform!: PwaPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}

/** The encryption keys a browser hands back from PushManager.subscribe(). */
export class PushKeysDto {
  @IsString()
  @MinLength(1)
  p256dh!: string;

  @IsString()
  @MinLength(1)
  auth!: string;
}

/** POST /v1/push/subscribe body. userId/clientId are taken from the JWT, NEVER here. */
export class SubscribeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}

/** POST /v1/push/unsubscribe body. */
export class UnsubscribeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  endpoint!: string;
}

/** Role groups the installed-users download can be narrowed to. */
export const INSTALLED_USERS_ROLE_GROUPS = ['sales', 'partner', 'admin'] as const;
export type InstalledUsersRoleGroup = (typeof INSTALLED_USERS_ROLE_GROUPS)[number];

/**
 * GET /v1/push/adoption/installed-users query. Both filters optional; the tenant comes from the
 * JWT only (no clientId param exists).
 */
export class InstalledUsersQueryDto {
  @IsOptional()
  @IsIn(INSTALLED_USERS_ROLE_GROUPS, { message: 'roleGroup must be one of: sales, partner, admin' })
  roleGroup?: InstalledUsersRoleGroup;

  /** Only users whose FIRST install is on/after this IST calendar date (YYYY-MM-DD). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'since must be a date like 2026-11-01' })
  since?: string;
}

import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
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

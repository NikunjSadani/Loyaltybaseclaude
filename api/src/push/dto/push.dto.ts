import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

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

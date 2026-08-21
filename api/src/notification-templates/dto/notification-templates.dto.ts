/**
 * DTO for PUT /v1/admin/notification-templates — the per-tenant notification-templates config.
 *
 * ⚠️ WHITELIST-PIPE HAZARD (the exact bug that 400'd every TDS-statutory save): the global
 * ValidationPipe runs with { whitelist: true, forbidNonWhitelisted: true }. A nested object
 * declared WITHOUT a @Type()/@ValidateNested() target class has its inner properties STRIPPED
 * before the handler sees them — so a bare `events: object` would arrive empty and every save
 * would look like a no-op / 400. This DTO therefore models `events` as a nested EventsMapDto whose
 * ten EVENT_KEY properties are each a @ValidateNested + @Type(() => EventChannelDto). That makes
 * class-transformer instantiate the nested classes (so mode/templates SURVIVE the whitelist) and,
 * because forbidNonWhitelisted applies at the nested level too, an UNKNOWN event key is rejected
 * with a 400 automatically. The service re-validates (validateNotificationTemplatesInput) as
 * defense-in-depth.
 */
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_TEMPLATE_LEN, NOTIFICATION_MODES, NotificationMode } from '../notification-templates.config';

/** One event's channel config. Every field decorated so it survives the whitelist pipe. */
export class EventChannelDto {
  @IsIn(NOTIFICATION_MODES as unknown as string[], {
    message: `mode must be one of ${NOTIFICATION_MODES.join(', ')}`,
  })
  mode!: NotificationMode;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEMPLATE_LEN)
  whatsappTemplate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEMPLATE_LEN)
  smsTemplateId?: string;
}

/**
 * The events map. Each of the ten EVENT_KEYS is an OPTIONAL nested EventChannelDto — an operator
 * may send any subset (omitted events resolve to their OFF default at read time). Because these
 * are the ONLY whitelisted properties, forbidNonWhitelisted makes any other (unknown) event key a
 * 400. Keep this list EXACTLY in sync with EVENT_KEYS in notification-templates.config.ts.
 */
export class EventsMapDto {
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) KYC_SUBMITTED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) KYC_APPROVED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) KYC_REJECTED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) KYC_UNDER_REVIEW?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) POINTS_CREDITED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) PAYOUT_CREDITED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) REDEMPTION_CONFIRMED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) ORDER_DISPATCHED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) ORDER_DELIVERED?: EventChannelDto;
  @IsOptional() @ValidateNested() @Type(() => EventChannelDto) ORDER_CANCELLED?: EventChannelDto;
}

export class SetNotificationTemplatesDto {
  @IsBoolean()
  masterSms!: boolean;

  @IsBoolean()
  masterWhatsapp!: boolean;

  /**
   * The per-event channel map. Optional so a masters-only PUT is valid; when present it MUST be a
   * nested EventsMapDto so the whitelist pipe keeps its inner values (see the file header).
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EventsMapDto)
  events?: EventsMapDto;
}

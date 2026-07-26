import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for POST /v1/schemes/:id/broadcast (D29 — the ad-hoc scheme notification
 * broadcast tool). GIFSY_ADMIN-only. The admin can trigger this MULTIPLE times
 * during a scheme's life; each call resolves the current recipient set and
 * writes ONE SchemeBroadcast send-log row.
 *
 * Reuses the existing MSG91 infra directly (the NotificationQueue worker is a
 * seam only): WHATSAPP → msg91.sendWhatsappTemplate; SMS → msg91.sendOtp (an
 * MSG91 SMS/OTP template carries a single {{var}} — bodyValues[0]).
 */
export const BROADCAST_CHANNELS = ['WHATSAPP', 'SMS'] as const;
export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];

export const BROADCAST_SCOPES = ['OUTLETS', 'SALES', 'BOTH'] as const;
export type BroadcastScope = (typeof BROADCAST_SCOPES)[number];

/**
 * Optional filter narrowing the recipient set.
 *   - OUTLETS/BOTH: `zones/programNames/programCategories/outletTypeIds/states`
 *     narrow the matched-outlet roster rows (standalone rows are excluded when
 *     any outlet filter is set — they carry no outlet master attributes/phone).
 *   - SALES/BOTH: `taggedSalesUserIds` narrows the roster's tagged employees
 *     before the up-hierarchy walk (D20).
 * All optional — an absent filter targets the full scope.
 */
export class BroadcastRecipientFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  zones?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  programNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  programCategories?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  outletTypeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  states?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  taggedSalesUserIds?: string[];
}

export class BroadcastDto {
  @IsIn(BROADCAST_CHANNELS as unknown as string[], {
    message: `channel must be one of: ${BROADCAST_CHANNELS.join(', ')}`,
  })
  channel!: BroadcastChannel;

  /** MSG91-registered template name/id (WhatsApp template name, or SMS/OTP template id). */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  templateId!: string;

  @IsIn(BROADCAST_SCOPES as unknown as string[], {
    message: `recipientScope must be one of: ${BROADCAST_SCOPES.join(', ')}`,
  })
  recipientScope!: BroadcastScope;

  /** Optional narrowing of the recipient set (see BroadcastRecipientFilterDto). */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BroadcastRecipientFilterDto)
  recipientFilter?: BroadcastRecipientFilterDto;

  /**
   * Ordered template body variables → body_1, body_2, … (WhatsApp) or the single
   * {{var}} (SMS, bodyValues[0]). Optional; a template with no variables sends [].
   * Capped to defend the outbound payload.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  bodyValues?: string[];
}

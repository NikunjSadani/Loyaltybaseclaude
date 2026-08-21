import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * WhatsApp broadcast DTOs (Gifsy-operator only).
 *
 * ⚠️ Every nested object/array carries BOTH `@ValidateNested()` + `@Type(() => Class)`
 * so it survives the global `whitelist:true`/`forbidNonWhitelisted:true` ValidationPipe
 * (a nested field without `@Type` is stripped → a request that included it 400s).
 */
export const BROADCAST_AUDIENCE_MODES = ['FILTER', 'EXCEL'] as const;
export type BroadcastAudienceModeDto = (typeof BROADCAST_AUDIENCE_MODES)[number];

export const BROADCAST_AUDIENCE_SCOPES = ['OUTLETS', 'SALES', 'BOTH'] as const;
export type BroadcastAudienceScopeDto = (typeof BROADCAST_AUDIENCE_SCOPES)[number];

/** FILTER-mode outlet-facet filter (inclusion lists; empty facet = match all). */
export class BroadcastFilterDto {
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

  /** Cities (Outlet.city inclusion). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cities?: string[];

  /**
   * Owner-group ids (parent-child groups). Each value is a PARENT ChannelPartner id =
   * the group key mirrored on `Outlet.parentId`; filters outlets to those groups.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupIds?: string[];

  /** kycApprovedOnly → only active/KYC-approved outlets (maps to Outlet.isActive). */
  @IsOptional()
  @IsBoolean()
  kycApprovedOnly?: boolean;
}

/**
 * FILTER mode — how each template variable (by 1-based index) is filled per recipient:
 *   - `source`: a field key off the resolved outlet/sales record (e.g. 'ownerName',
 *     'name', 'outletCode', 'zone', 'phone').
 *   - `value`: a constant used for every recipient (takes precedence when both set).
 * A variable with neither resolves to '' (empty string) for that recipient.
 */
export class VariableMappingItemDto {
  @IsInt()
  @Min(1)
  index!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  value?: string;
}

/** EXCEL mode — one uploaded recipient: a phone + ordered variable values. */
export class ExcelRecipientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  variables?: string[];
}

/**
 * Preview — resolve the audience and render sample messages. NO send, NO rows.
 * `templateId` is required so the sample can render the real body.
 */
export class PreviewBroadcastDto {
  @IsString()
  @MinLength(1)
  templateId!: string;

  @IsIn(BROADCAST_AUDIENCE_MODES as unknown as string[], {
    message: `mode must be one of: ${BROADCAST_AUDIENCE_MODES.join(', ')}`,
  })
  mode!: BroadcastAudienceModeDto;

  @IsOptional()
  @IsIn(BROADCAST_AUDIENCE_SCOPES as unknown as string[], {
    message: `scope must be one of: ${BROADCAST_AUDIENCE_SCOPES.join(', ')}`,
  })
  scope?: BroadcastAudienceScopeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BroadcastFilterDto)
  filter?: BroadcastFilterDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VariableMappingItemDto)
  variableMapping?: VariableMappingItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50000)
  @ValidateNested({ each: true })
  @Type(() => ExcelRecipientDto)
  excelRows?: ExcelRecipientDto[];
}

/** Create — same audience shape as preview, plus a title + optional schedule. */
export class CreateBroadcastDto extends PreviewBroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /** ISO-8601; when in the future the broadcast is SCHEDULED (else sent now). */
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  /**
   * The recipient count the operator confirmed at preview. The service re-resolves the
   * audience live at create and 409s if the fresh count exceeds this beyond a small
   * tolerance — so a FILTER that grew between preview and send can't silently over-send.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedCount?: number;
}

/** test-send — 1..5 bare/loose phone numbers; no campaign rows are written. */
export class TestSendDto {
  @IsString()
  @MinLength(1)
  templateId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  phones!: string[];

  /** Optional ordered variable values used for every test message. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  variables?: string[];
}

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * DTOs for the banner-config sub-domain — ported from
 * platform/src/app/api/admin/banner-config/route.ts.
 *
 * The config is a JSON blob persisted under the `banner_config` ProgramSetting
 * key (no dedicated model). `audience` keeps the source enum values
 * (ALL / SSS / WHOLESALER / SUB_STOCKIST) verbatim.
 */
export enum BannerAudience {
  ALL = 'ALL',
  SSS = 'SSS',
  WHOLESALER = 'WHOLESALER',
  SUB_STOCKIST = 'SUB_STOCKIST',
}

export enum BannerItemType {
  TEXT = 'text',
  VIDEO = 'video',
}

export enum PopupItemType {
  TEXT = 'text',
  VIDEO = 'video',
  IMAGE = 'image',
}

export enum PopupFrequency {
  ALWAYS = 'always',
  ONCE = 'once',
  DAILY = 'daily',
}

export class BannerItemDto {
  @IsString() id!: string;
  @IsBoolean() active!: boolean;
  @IsEnum(BannerItemType) type!: BannerItemType;
  @IsString() title!: string;
  @IsString() body!: string;
  @IsString() ctaLabel!: string;
  @IsString() ctaUrl!: string;
  @IsString() videoUrl!: string;
  @IsString() bgColor!: string;
  @IsEnum(BannerAudience) audience!: BannerAudience;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number = 0;

  @IsOptional() @IsString() startDate?: string = '';
  @IsOptional() @IsString() endDate?: string = '';

  @IsOptional()
  @IsBoolean()
  showInSalesApp?: boolean = false;

  @IsString() updatedAt!: string;
}

export class PopupItemDto {
  @IsString() id!: string;
  @IsBoolean() active!: boolean;
  @IsEnum(PopupItemType) type!: PopupItemType;
  @IsString() title!: string;
  @IsString() body!: string;
  @IsString() imageUrl!: string;
  @IsString() videoUrl!: string;
  @IsString() ctaLabel!: string;
  @IsString() ctaUrl!: string;
  @IsString() bgColor!: string;
  @IsEnum(PopupFrequency) frequency!: PopupFrequency;
  @IsEnum(BannerAudience) audience!: BannerAudience;
  @IsString() updatedAt!: string;
}

/** Body for PUT /v1/admin/banner-config — the full config (banners + popups). */
export class UpdateBannerConfigDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BannerItemDto)
  banners!: BannerItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PopupItemDto)
  popups?: PopupItemDto[] = [];
}

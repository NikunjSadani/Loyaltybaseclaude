import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { OFFER_GROUPS, OFFER_VALUE_TYPES, OfferGroup, OfferValueType } from '../offers.types';

/**
 * Offer-tile DTOs (platform/docs/plans/OFFER-TILES-PLAN.md §3.3). Decorators enforce TYPES +
 * generous outer caps only; the precise, human-worded rules (lengths after trim, value-type
 * cross-field rules, date order, PERCENT ≤ 100 …) live in `validateTileInput` (offers.helpers.ts),
 * which also validates the MERGED row on PATCH.
 *
 * UpdateOfferTileDto is written BY HAND (every field @IsOptional) — @nestjs/mapped-types is NOT a
 * dependency and adding one risks the boot-crash trap. No property initializers: a default here
 * would silently apply to a PATCH.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MSG = 'must be a date in YYYY-MM-DD format';
const MONTH_MSG = 'must be a month in YYYY-MM format';

export class CreateOfferTileDto {
  @IsIn(OFFER_GROUPS as unknown as string[])
  group!: OfferGroup;

  @IsIn(OFFER_VALUE_TYPES as unknown as string[])
  valueType!: OfferValueType;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  valueNumber?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  valueText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  unitLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  product?: string | null;

  @IsString()
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  details?: string | null;

  @Matches(DAY, { message: `validFrom ${DAY_MSG}` })
  validFrom!: string;

  @Matches(DAY, { message: `validTo ${DAY_MSG}` })
  validTo!: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  programNames?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  outletTypeCodes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  zones?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  states?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  kpiCode?: string | null;
}

export class UpdateOfferTileDto {
  @IsOptional()
  @IsIn(OFFER_GROUPS as unknown as string[])
  group?: OfferGroup;

  @IsOptional()
  @IsIn(OFFER_VALUE_TYPES as unknown as string[])
  valueType?: OfferValueType;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  valueNumber?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  valueText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  unitLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  product?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  details?: string | null;

  @IsOptional()
  @Matches(DAY, { message: `validFrom ${DAY_MSG}` })
  validFrom?: string;

  @IsOptional()
  @Matches(DAY, { message: `validTo ${DAY_MSG}` })
  validTo?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  programNames?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  outletTypeCodes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  zones?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  states?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  kpiCode?: string | null;
}

export class ListOffersQueryDto {
  @Matches(MONTH, { message: `month ${MONTH_MSG}` })
  month!: string;
}

export class CopyMonthDto {
  @Matches(MONTH, { message: `fromMonth ${MONTH_MSG}` })
  fromMonth!: string;

  @Matches(MONTH, { message: `toMonth ${MONTH_MSG}` })
  toMonth!: string;
}

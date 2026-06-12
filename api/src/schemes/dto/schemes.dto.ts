import {
  IsString, IsOptional, IsEnum, IsInt, IsNumber, IsBoolean,
  IsDateString, Min,
} from 'class-validator';

export class CreateSchemeDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsEnum([
    'PURCHASE_INCENTIVE', 'VISIBILITY', 'GROWTH_INCENTIVE', 'REFERRAL',
    'WELCOME_BONUS', 'MILESTONE', 'SLAB_BASED', 'TARGET_BASED',
  ])
  schemeType!: string;

  @IsEnum(['POINTS', 'CASHBACK', 'GIFT_CARD', 'PHYSICAL_GIFT', 'VOUCHER'])
  rewardType!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional() @IsNumber()
  pointsPerRupee?: number;

  @IsOptional() @IsInt() @Min(0)
  fixedPoints?: number;

  @IsOptional() @IsInt() @Min(0)
  maxPointsPerCycle?: number;

  @IsOptional() @IsInt() @Min(0)
  budgetPaise?: number;

  @IsOptional() @IsInt() @Min(0)
  holdingPeriodDays?: number;

  @IsOptional() @IsBoolean()
  isStackable?: boolean;

  @IsOptional() @IsInt() @Min(0)
  priority?: number;

  @IsOptional() @IsString()
  termsAndConditions?: string;
}

import {
  IsString, IsOptional, IsInt, IsArray, IsEnum, Min,
} from 'class-validator';

export class CreateLeaderboardConfigDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsEnum(['POINTS_EARNED', 'SALES_VALUE', 'GROWTH_PERCENTAGE', 'REDEMPTION_COUNT'])
  leaderboardType!: string;

  @IsEnum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ALL_TIME'])
  period!: string;

  @IsInt() @Min(1)
  topN!: number;

  @IsOptional() @IsInt() @Min(0)
  rewardPoints?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  eligibleClasses?: string[];
}

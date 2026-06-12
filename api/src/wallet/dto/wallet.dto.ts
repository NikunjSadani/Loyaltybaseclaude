import { IsString, IsInt, IsOptional, Min } from 'class-validator';

export class EarnPointsDto {
  @IsString()
  partnerId!: string;

  @IsInt() @Min(1)
  points!: number;

  @IsOptional() @IsString()
  referenceType?: string;

  @IsOptional() @IsString()
  referenceId?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  schemeId?: string;
}

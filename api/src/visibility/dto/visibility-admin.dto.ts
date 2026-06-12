import {
  IsString, IsOptional, IsInt, IsDateString, Min, IsArray, IsEnum,
} from 'class-validator';

export class CreateVisibilityProgramDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsInt() @Min(0)
  pointsPerSubmission!: number;

  @IsOptional() @IsInt() @Min(1)
  maxSubmissionsPerMonth?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  eligibleClasses?: string[];
}

export class UpdateVisibilityProgramDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @IsInt() @Min(0)
  pointsPerSubmission?: number;

  @IsOptional() @IsInt() @Min(1)
  maxSubmissionsPerMonth?: number;

  @IsOptional()
  @IsEnum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED'])
  status?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  eligibleClasses?: string[];
}

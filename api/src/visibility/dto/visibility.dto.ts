import { IsString, IsOptional, IsNumber } from 'class-validator';

export class SubmitPhotoDto {
  @IsString()
  programId!: string;

  @IsString()
  outletId!: string;

  @IsString()
  imageUrl!: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  notes?: string;
}

export class RejectSubmissionDto {
  @IsString()
  reason!: string;
}

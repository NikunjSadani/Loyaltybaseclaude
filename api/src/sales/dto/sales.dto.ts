import {
  IsString, IsInt, IsOptional, IsArray, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUploadDto {
  @IsString()
  fileName!: string;

  @IsString()
  fileUrl!: string;

  @IsString()
  fileKey!: string;

  @IsInt() @Min(0)
  fileSizeBytes!: number;
}

export class PointsAwardRowDto {
  @IsString()
  partnerId!: string;

  @IsString()
  skuCode!: string;

  @IsInt() @Min(0)
  invoicePoints!: number;

  @IsOptional() @IsString()
  month?: string;
}

export class ProcessRowsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PointsAwardRowDto)
  rows!: PointsAwardRowDto[];
}

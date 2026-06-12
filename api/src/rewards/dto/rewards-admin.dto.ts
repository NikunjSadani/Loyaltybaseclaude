import {
  IsString, IsInt, IsOptional, IsArray, IsEnum, Min,
} from 'class-validator';

export class CreateCatalogItemDto {
  @IsString()
  categoryId!: string;

  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsInt() @Min(1)
  pointsCost!: number;

  @IsEnum(['GIFT_CARD', 'UPI', 'BANK_TRANSFER', 'PHYSICAL_GIFT'])
  redemptionMode!: string;

  @IsOptional() @IsInt() @Min(0)
  mrpPaise?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  eligibleClasses?: string[];

  @IsOptional() @IsString()
  termsAndConditions?: string;

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number;
}

export class UpdateCatalogItemDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsInt() @Min(1)
  pointsCost?: number;

  @IsOptional()
  @IsEnum(['ACTIVE', 'INACTIVE', 'OUT_OF_STOCK', 'DISCONTINUED'])
  status?: string;

  @IsOptional() @IsString()
  termsAndConditions?: string;

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  eligibleClasses?: string[];
}

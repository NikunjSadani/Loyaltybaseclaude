import {
  IsString, IsOptional, IsInt, IsNumber, IsBoolean, IsArray, Min,
} from 'class-validator';

export class CreateSkuDto {
  @IsString()
  skuCode!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  brand?: string;

  @IsString()
  uom!: string;

  @IsOptional() @IsInt() @Min(1)
  packSize?: number;

  @IsInt() @Min(0)
  mrpPaise!: number;

  @IsOptional() @IsInt() @Min(0)
  dealerPricePaise?: number;

  @IsOptional() @IsString()
  imageUrl?: string;

  @IsOptional() @IsBoolean()
  isTaxable?: boolean;

  @IsOptional() @IsString()
  hsn?: string;

  @IsOptional() @IsNumber()
  gstRate?: number;

  @IsOptional() @IsArray() @IsString({ each: true })
  categoryIds?: string[];
}

import {
  IsString, IsOptional, IsNumber,
} from 'class-validator';

export class CreateOutletDto {
  @IsString()
  partnerId!: string;

  @IsString()
  outletTypeId!: string;

  @IsString()
  name!: string;

  @IsOptional() @IsString()
  ownerName?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsString()
  addressLine1!: string;

  @IsOptional() @IsString()
  addressLine2?: string;

  @IsString()
  city!: string;

  @IsOptional() @IsString()
  district?: string;

  @IsString()
  state!: string;

  @IsString()
  pincode!: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;
}

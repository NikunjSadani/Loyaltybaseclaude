import {
  IsString, IsInt, IsOptional, IsIn, ValidateNested,
  Min, IsArray, IsEnum, IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryAddressDto {
  @IsString() name!:    string;
  @IsString() mobile!:  string;
  @IsString() address!: string;
  @IsString() city!:    string;
  @IsString() state!:   string;
  @IsString() pincode!: string;
}

export class InitiateRedemptionDto {
  @IsString()
  rewardId!: string;

  @IsOptional() @IsInt() @Min(1)
  quantity?: number;

  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  deliveryAddress!: DeliveryAddressDto;
}

export class ConfirmRedemptionDto {
  @IsString() orderId!: string;
  @IsString() otp!:     string;
}

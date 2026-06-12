import {
  IsString, IsOptional, IsEmail, IsEnum, Matches,
} from 'class-validator';

export class CreatePartnerDto {
  @IsEnum(['CP_01', 'CP_02', 'CP_03'])
  partnerClassCode!: string;

  @IsString()
  businessName!: string;

  @IsString()
  ownerName!: string;

  @Matches(/^[6-9]\d{9}$/, { message: 'phone must be a valid 10-digit Indian mobile number' })
  phone!: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString()
  gstNumber?: string;

  @IsOptional() @IsString()
  panNumber?: string;
}

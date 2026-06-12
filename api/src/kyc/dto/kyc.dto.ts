import {
  IsString, IsBoolean, IsOptional, IsArray, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class KycPhonesDto {
  @IsOptional() @IsString() XSR?: string;
  @IsOptional() @IsString() SO?:  string;
  @IsOptional() @IsString() ASM?: string;
  @IsOptional() @IsString() RSM?: string;
  @IsOptional() @IsString() ZM?:  string;
  @IsOptional() @IsString() NM?:  string;
}

export class SubmitKycDto {
  @IsString()
  partnerId!: string;

  @ValidateNested()
  @Type(() => KycPhonesDto)
  phones!: KycPhonesDto;
}

export class RejectKycDto {
  @IsString()
  reason!: string;
}

export class ApprovePhotoDto {
  @IsBoolean()
  approved!: boolean;

  @IsOptional() @IsString()
  reason?: string;
}

export class BulkGstRowDto {
  @IsString()   kycId!:       string;
  @IsBoolean()  gstVerified!: boolean;
  @IsOptional() @IsString() reason?: string;
}

export class BulkGstDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkGstRowDto)
  rows!: BulkGstRowDto[];
}

export class BulkPennyDropRowDto {
  @IsString()   kycId!:        string;
  @IsBoolean()  bankVerified!: boolean;
  @IsOptional() @IsString() reason?: string;
}

export class BulkPennyDropDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkPennyDropRowDto)
  rows!: BulkPennyDropRowDto[];
}

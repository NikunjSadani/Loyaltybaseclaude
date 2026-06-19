import { IsString, IsNotEmpty, IsMobilePhone, IsIn, Length } from 'class-validator';

export class SendOtpDto {
  @IsMobilePhone('en-IN', {}, { message: 'Must be a valid 10-digit Indian mobile number' })
  @IsNotEmpty()
  phone: string;

  @IsIn(['SMS', 'WHATSAPP'], { message: 'channel must be SMS or WHATSAPP' })
  channel: 'SMS' | 'WHATSAPP';
}

export class VerifyOtpDto {
  @IsMobilePhone('en-IN', {}, { message: 'Must be a valid 10-digit Indian mobile number' })
  @IsNotEmpty()
  phone: string;

  @IsString()
  @Length(4, 6, { message: 'OTP must be 4–6 digits' })
  otp: string;

  /** The subdomain slug resolved by the proxy — passed from the frontend via header */
  @IsString()
  @IsNotEmpty()
  clientId: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/** POST /v1/auth/assume-tenant — the GIFSY operator-context switcher (A2/#51). */
export class AssumeTenantDto {
  /** The target tenant's clientId slug to work inside (e.g. "deoleo"). */
  @IsString()
  @IsNotEmpty()
  clientId: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = 'must be a date (YYYY-MM-DD)';

/** GET /v1/fund/statement */
export class FundStatementQueryDto {
  @IsOptional() @Matches(DATE_RE, { message: `from ${DATE_MSG}` }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: `to ${DATE_MSG}` }) to?: string;
  @IsOptional() @IsIn(['VOUCHER', 'CASH_REDEMPTION', 'CREDIT_PAYOUT', 'VISIBILITY_PAYOUT', 'TDS_194C']) type?: string;
  @IsOptional() @IsIn(['COMMITTED', 'PAID', 'RETURNED']) status?: string;
  @IsOptional() @IsIn(['OPENING', 'RECEIPT', 'ADJUSTMENT', 'CHARGE', 'RETURN']) event?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** GET /v1/fund/export */
export class FundExportQueryDto {
  @IsOptional() @Matches(DATE_RE, { message: `from ${DATE_MSG}` }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: `to ${DATE_MSG}` }) to?: string;
}

/** POST /v1/fund/receipts — an advance received (rupees; converted to paise ONCE on the server). */
export class RecordFundReceiptDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Amount must be a number with at most 2 decimals' })
  @Min(0.01, { message: 'Amount must be more than ₹0' })
  @Max(1_000_000_000, { message: 'Amount is too large' })
  amountRupees!: number;

  @Matches(DATE_RE, { message: `receivedOn ${DATE_MSG}` })
  receivedOn!: string;

  @IsString()
  @IsNotEmpty({ message: 'UTR / reference is required' })
  @MaxLength(100)
  referenceNumber!: string;

  @IsOptional() @IsString() @MaxLength(100) bankName?: string;
  @IsOptional() @IsString() @MaxLength(40) paymentMode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** POST /v1/fund/adjustments — a signed correction with a mandatory reason. */
export class RecordFundAdjustmentDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Amount must be a number with at most 2 decimals' })
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  amountRupees!: number;

  @Matches(DATE_RE, { message: `date ${DATE_MSG}` })
  date!: string;

  @IsString()
  @IsNotEmpty({ message: 'A reason is required for an adjustment' })
  @MaxLength(500)
  reason!: string;
}

/** POST /v1/fund/opening-balance — once per client. */
export class RecordOpeningBalanceDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Amount must be a number with at most 2 decimals' })
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  amountRupees!: number;

  @Matches(DATE_RE, { message: `asOfDate ${DATE_MSG}` })
  asOfDate!: string;

  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** PUT /v1/fund/settings/alerts */
export class UpdateFundAlertsDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  thresholdRupees?: number | null;

  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true, message: 'Each alert recipient must be a valid e-mail address' })
  alertRecipients!: string[];
}

/** POST /v1/fund/rates/fee */
export class SetAgencyFeeDto {
  @IsIn(['PERCENT', 'FLAT'])
  feeType!: 'PERCENT' | 'FLAT';

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) percent?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) flatRupees?: number;

  @Matches(DATE_RE, { message: `effectiveFrom ${DATE_MSG}` })
  effectiveFrom!: string;

  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** POST /v1/fund/rates/discount */
export class SetBrandDiscountDto {
  @IsString() @IsNotEmpty() @MaxLength(200) brandKey!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) brandLabel!: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) percent!: number;

  @Matches(DATE_RE, { message: `effectiveFrom ${DATE_MSG}` })
  effectiveFrom!: string;

  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

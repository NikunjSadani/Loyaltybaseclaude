import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Upper-case + trim a legal-ID field (PAN/GST) at DTO transform time — defense-in-depth so a
 * lower-case value is canonicalised BEFORE it reaches the service (which also normalises), keeping
 * it in step with the case-sensitive partial-unique DB index. Non-string input passes through
 * untouched (class-validator then rejects it if required).
 */
const upperCaseId = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Create a PARENT owner (docs/plans/PARTNER-MULTI-OUTLET.md §2.2) — a non-operating
 * ChannelPartner (isParent=true) that groups child outlets via Outlet.parentId.
 *
 * Minimum = just an ID (`partnerCode`). A parent is created LOGIN-LESS (userId=null) and
 * WALLET-LESS. It MAY carry its own GST/PAN/bank details + an optional contact phone; when
 * it carries details it awaits its own straight-to-Gifsy approval (approveParent).
 */
export class CreateParentDto {
  /** The parent's code — the admin-facing identifier used in the outlet-master Parent ID column. */
  @IsString()
  @IsNotEmpty()
  partnerCode!: string;

  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  /** Optional contact/login phone (Stream D resolves the picker "Group Overview" by phone-match). */
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @Transform(upperCaseId)
  @IsString()
  gstNumber?: string;

  @IsOptional()
  @Transform(upperCaseId)
  @IsString()
  panNumber?: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  bankAccountHolder?: string;

  @IsOptional()
  @IsString()
  ifscCode?: string;

  @IsOptional()
  @IsString()
  upiId?: string;
}

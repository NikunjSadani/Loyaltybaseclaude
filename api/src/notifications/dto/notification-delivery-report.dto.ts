import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Query filters for the transactional delivery-status report surface (Wave 4).
 *
 * ⚠️ Global ValidationPipe is `whitelist:true, forbidNonWhitelisted:true` — every query param the
 * FE sends MUST be declared+decorated here or it is SILENTLY STRIPPED (the trap that bit the gift
 * module). Keep this DTO in exact sync with what the FE puts on the query string.
 *
 * ISOLATION: there is DELIBERATELY no `clientId` field. The tenant scope is derived from the JWT
 * (tenantScope) in the service, never from input — so a CLIENT_ADMIN can never widen their view and
 * a GIFSY_ADMIN can never target a tenant by param (they use assume-tenant instead). Even if a
 * caller appended `?clientId=…`, forbidNonWhitelisted would 400 it.
 */
export class NotificationDeliverySummaryQueryDto {
  /** Restrict to a single transactional channel. Only SMS + WHATSAPP have receipts. */
  @IsOptional()
  @IsIn(['SMS', 'WHATSAPP'])
  channel?: 'SMS' | 'WHATSAPP';

  /** Inclusive createdAt window (ISO date/datetime). */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Filter by the notification trigger key (eventKey), e.g. an ORDER_APPROVED trigger / DLT template. */
  @IsOptional()
  @IsString()
  event?: string;
}

/** The per-message list adds pagination on top of the shared summary filters. */
export class NotificationDeliveryListQueryDto extends NotificationDeliverySummaryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}

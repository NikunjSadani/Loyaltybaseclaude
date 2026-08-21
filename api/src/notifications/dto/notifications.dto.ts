import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * GET /v1/notifications query. A global ValidationPipe runs with `whitelist: true`,
 * which STRIPS any undecorated property — so cursor/limit MUST be decorated here or
 * they never reach the handler. `transform: true` + enableImplicitConversion coerces
 * the raw string `limit` to a number; @Type makes that explicit and robust.
 */
export class FeedQueryDto {
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  /** Page size (default 25 in the service, capped at 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

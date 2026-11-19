import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  Max,
} from 'class-validator';
import { PAGE_SIZE_MAX } from '../../common/validators/page-size';
import { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';

export class CreateTicketDto {
  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  subject!: string;

  @IsString()
  @MinLength(1)
  description!: string;

  /**
   * Optional — the outlet this ticket is about (Outlet.id). Sent by the sales app's "For an
   * Outlet" flow; validated against the raiser's scope and stored as referenceType 'OUTLET'.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  outletId?: string;
}

export class EscalateTicketDto {
  @IsString()
  @MinLength(1, { message: 'Escalation target user ID is required' })
  escalateTo!: string;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority; // service defaults to HIGH
}

/**
 * Assign / unassign a ticket (Gifsy operators only). `assigneeId: null` unassigns. The
 * assignee must be an active Gifsy operator who may work on the ticket's tenant (owner, or
 * staff holding a grant for it) or an active CLIENT_ADMIN of the ticket's own tenant.
 */
export class AssignTicketDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  assigneeId!: string | null;
}

/** Gifsy asks one of the ticket tenant's CLIENT_ADMINs for remarks. */
export class RequestClientRemarksDto {
  @IsString()
  @MinLength(1, { message: 'Pick the client admin to ask' })
  clientAdminId!: string;

  @IsString()
  @MinLength(1, { message: 'Describe what you need from the client admin' })
  @MaxLength(2000)
  note!: string;
}

/** The client admin's reply to a remarks request (stored as an INTERNAL message). */
export class ClientRemarksReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}

/** Allowed status transitions a support admin can drive from the console. */
export const SETTABLE_TICKET_STATUSES = ['RESOLVED', 'CLOSED', 'IN_PROGRESS', 'OPEN'] as const;
export type SettableTicketStatus = (typeof SETTABLE_TICKET_STATUSES)[number];

export class SetTicketStatusDto {
  @IsString()
  @IsIn(SETTABLE_TICKET_STATUSES)
  status!: SettableTicketStatus;
}

export class AddMessageDto {
  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean; // defaults to false
}

export class ListTicketsQueryDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  /** CLIENT_ADMIN only: just the tickets waiting on THIS admin's remarks. */
  @IsOptional()
  @IsIn(['true', 'false'])
  awaitingMine?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_SIZE_MAX)
  limit?: number = 20;
}

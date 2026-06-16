import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

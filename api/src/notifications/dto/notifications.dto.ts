import { IsString, IsOptional, IsIn } from 'class-validator';

export class EnqueueNotificationDto {
  @IsString()
  userId!: string;

  @IsIn(['SMS', 'EMAIL', 'PUSH', 'WHATSAPP'])
  channel!: string;

  @IsString()
  body!: string;

  @IsOptional() @IsString()
  recipientPhone?: string;

  @IsOptional() @IsString()
  recipientEmail?: string;

  @IsOptional() @IsString()
  recipientFcm?: string;

  @IsOptional() @IsString()
  subject?: string;

  @IsOptional() @IsString()
  templateId?: string;
}

import { IsString, IsBoolean, IsOptional, IsObject, IsEmail, IsMobilePhone } from 'class-validator';

// ── Client config ─────────────────────────────────────────────────────────────

export class ClientFeaturesDto {
  @IsBoolean() loyalty!:        boolean;
  @IsBoolean() visibility!:     boolean;
  @IsBoolean() leaderboard!:    boolean;
  @IsBoolean() schemes!:        boolean;
  @IsBoolean() selfEnrollment!: boolean;
  @IsBoolean() targets!:        boolean;
  @IsBoolean() rewards!:        boolean;
  @IsBoolean() tds!:            boolean;
}

export class ClientBrandingDto {
  @IsString()   primaryColor!: string;
  @IsString()   displayName!:  string;
  @IsOptional() @IsString() logoUrl?: string;
}

export class UpsertClientDto {
  @IsString()   slug!:     string;
  @IsString()   name!:     string;
  @IsObject()   features!: ClientFeaturesDto;
  @IsObject()   branding!: ClientBrandingDto;
  @IsBoolean()  isActive!: boolean;
}

// ── Create user ───────────────────────────────────────────────────────────────

export class CreateClientUserDto {
  @IsString()               name!:   string;
  @IsString()               phone!:  string;
  @IsString()               role!:   string;
  @IsOptional() @IsEmail()  email?:  string;
}

// ── Outlet type config ────────────────────────────────────────────────────────

export class UpsertOutletTypeConfigDto {
  @IsOptional() @IsBoolean() isEnabled?:          boolean;
  @IsOptional() @IsString()  displayName?:         string | null;
  @IsOptional() @IsBoolean() loyaltyEnabled?:      boolean;
  @IsOptional() @IsBoolean() schemesEnabled?:      boolean;
  @IsOptional() @IsBoolean() visibilityEnabled?:   boolean;
  @IsOptional() @IsBoolean() payoutsEnabled?:      boolean;
  @IsOptional() @IsBoolean() leaderboardEnabled?:  boolean;
  @IsOptional() @IsBoolean() targetsEnabled?:      boolean;
  @IsOptional() @IsBoolean() kycRequired?:         boolean;
}

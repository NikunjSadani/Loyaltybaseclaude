-- Additive enum value: a KYC verification field auto-verified via group inheritance.
-- Postgres cannot ADD VALUE inside a transaction block, so this is a single standalone
-- statement (Prisma wraps each migration in a tx UNLESS it is a lone ALTER TYPE ... ADD VALUE).
ALTER TYPE "KycFieldSource" ADD VALUE IF NOT EXISTS 'GROUP_INHERITED';

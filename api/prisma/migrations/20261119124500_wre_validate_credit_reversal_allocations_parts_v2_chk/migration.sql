-- Wallet Reversal Engine (owner decisions 2026-11-19) — VALIDATE the allocation parts CHECK added NOT VALID in
-- 20261119124400 (SHARE UPDATE EXCLUSIVE: reads and writes continue). ONE live table. Idempotent (VALIDATE is a no-op
-- when already valid). Plain session SET of lock_timeout (Prisma ignores SET LOCAL).
SET lock_timeout = '5s';

ALTER TABLE "credit_reversal_allocations" VALIDATE CONSTRAINT "credit_reversal_allocations_parts_v2_chk";

RESET lock_timeout;

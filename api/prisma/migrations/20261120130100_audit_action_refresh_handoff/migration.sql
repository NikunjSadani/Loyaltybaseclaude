-- Auth H4 / C1 (owner 2026-11-20): a distinct audit action for a never-used-successor handback (an info
-- event, deliberately NOT 'LOGIN' and NOT a SECURITY_EVENT). Additive + idempotent (IF NOT EXISTS).
-- Kept in its own migration: a new enum value cannot be USED in the transaction that adds it.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFRESH_HANDOFF';

-- Add point-in-time snapshot columns to audit-trail tables
--
-- These columns capture name / phone / employee-code AT THE MOMENT an action
-- is taken, so the record remains accurate even if the employee later resigns
-- (name blanked), is restructured (position abolished), or is deactivated.
--
-- All columns are nullable so existing rows are unaffected.

-- ── audit_logs ───────────────────────────────────────────────────────────────
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "actorName"    TEXT,
  ADD COLUMN IF NOT EXISTS "actorPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmpCode" TEXT;

-- ── sales_user_assignments ───────────────────────────────────────────────────
ALTER TABLE "sales_user_assignments"
  ADD COLUMN IF NOT EXISTS "salesUserName"       TEXT,
  ADD COLUMN IF NOT EXISTS "salesUserPhone"      TEXT,
  ADD COLUMN IF NOT EXISTS "salesUserEmpCode"    TEXT,
  ADD COLUMN IF NOT EXISTS "assignedByName"      TEXT,
  ADD COLUMN IF NOT EXISTS "assignedByPhone"     TEXT,
  ADD COLUMN IF NOT EXISTS "assignedByEmpCode"   TEXT,
  ADD COLUMN IF NOT EXISTS "unassignedByName"    TEXT,
  ADD COLUMN IF NOT EXISTS "unassignedByPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "unassignedByEmpCode" TEXT;

-- ── kyc_status_history ───────────────────────────────────────────────────────
ALTER TABLE "kyc_status_history"
  ADD COLUMN IF NOT EXISTS "changedByName"    TEXT,
  ADD COLUMN IF NOT EXISTS "changedByPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "changedByEmpCode" TEXT;

-- ── sales_uploads ────────────────────────────────────────────────────────────
ALTER TABLE "sales_uploads"
  ADD COLUMN IF NOT EXISTS "uploadedByName"    TEXT,
  ADD COLUMN IF NOT EXISTS "uploadedByPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "uploadedByEmpCode" TEXT;

-- Idempotent-rotation chain for the sliding 7-day session (multi-tab refresh fix).
-- Additive + nullable, NO backfill: existing rows keep rotatedFromId = NULL (login-minted
-- sessions have no predecessor). The successor row minted on each refresh stores the id of
-- the predecessor it rotated from, so a slow second tab replaying a just-revoked refresh
-- token (within the grace window) can be handed the live successor's stored tokens.
-- Table is "user_sessions" (Prisma @@map of model UserSession).
ALTER TABLE "user_sessions" ADD COLUMN "rotatedFromId" TEXT;

CREATE INDEX "user_sessions_rotatedFromId_idx" ON "user_sessions"("rotatedFromId");

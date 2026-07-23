-- Partner → multiple outlets (parent-child owner groups) — FOUNDATION.
-- See platform/docs/plans/PARTNER-MULTI-OUTLET.md.
--
-- Additive, forward-only, zero-downtime:
--   * `channel_partners.isParent` — a non-operating PARENT owner (no outlet, no spendable
--     wallet) that groups child outlets. NOT NULL DEFAULT false → every existing partner
--     back-fills to false (a normal operating owner), no behaviour change.
--   * `channel_partners.userId` / `.phone` are relaxed to NULLABLE — a bare parent may have
--     no login/phone. Every EXISTING row already has both set, so nothing is affected; the
--     `userId` UNIQUE index is unchanged (Postgres treats NULLs as distinct).
--   * `outlets.parentId` — the single authoritative group link (the admin "Parent ID"
--     upload column), FK → channel_partners(id) ON DELETE SET NULL. Nullable → every
--     existing outlet is ungrouped until an admin explicitly groups it (opt-in; zero impact
--     on the ~2,900 live Deoleo outlets).

-- ── channel_partners ────────────────────────────────────────────────────────────────────
ALTER TABLE "channel_partners"
    ADD COLUMN "isParent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "channel_partners"
    ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "channel_partners"
    ALTER COLUMN "phone" DROP NOT NULL;

-- ── outlets ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "outlets"
    ADD COLUMN "parentId" TEXT;

ALTER TABLE "outlets"
    ADD CONSTRAINT "outlets_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "channel_partners"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "outlets_parentId_idx" ON "outlets"("parentId");

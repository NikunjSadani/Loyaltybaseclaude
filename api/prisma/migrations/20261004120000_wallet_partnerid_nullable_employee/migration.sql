-- Employee Rewards Phase C — allow an ACCOUNT-FIRST employee wallet (STRICTLY ADDITIVE).
-- Drop the NOT NULL on wallets.partnerId so an EMPLOYEE wallet can be minted with only an
-- accountId (no ChannelPartner). The existing UNIQUE index + FK stay valid with NULLs: Postgres
-- treats NULLs as DISTINCT in a unique index, so many account-only employee wallets coexist while
-- each real partner still maps to at most one wallet. Every existing OUTLET wallet keeps its
-- partnerId, the FK/onDelete behaviour for linked partners is unchanged, and the live TRADE credit
-- path (confirmBatch → wallet.upsert(where partnerId) → creditEarn) is byte-identical. No backfill,
-- no drops of the index/constraint.
ALTER TABLE "wallets" ALTER COLUMN "partnerId" DROP NOT NULL;

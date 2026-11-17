-- Billing comparison read path (admin "Monthly billing progress" card): the latest outlet_sales_days row per outlet
-- with day <= D for one tenant + month:
--   SELECT DISTINCT ON ("outletId") … WHERE "clientId" = $1 AND "month" = $2 AND "day" <= $3 ORDER BY "outletId", "day" DESC
-- This ordered index returns rows already in the ORDER BY (Unique over an Index Scan, no Sort node).
-- ADDITIVE ONLY. Plain CREATE INDEX (Prisma runs a migration inside a transaction, where CONCURRENTLY is not allowed);
-- the table is new (20261118120000_sales_day_level) and small at deploy, so the build is brief. lock_timeout makes a
-- blocked lock wait fail fast (migration retried) instead of queueing writers behind it.
SET LOCAL lock_timeout = '10s';

CREATE INDEX "outlet_sales_days_clientId_month_outletId_day_idx" ON "outlet_sales_days"("clientId", "month", "outletId", "day" DESC);

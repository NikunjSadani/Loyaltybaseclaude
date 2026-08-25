-- Delivery-Status Reporting (Wave 1 fix) — add the index that supports the reconcile poll's
-- predicate (channel='SMS' AND status='SENT' AND sentAt < cutoff). Without it that scheduled
-- query is a sequential scan of message_delivery_receipts at scale. STRICTLY ADDITIVE: one
-- new index, no data change.
CREATE INDEX "message_delivery_receipts_channel_status_sentAt_idx" ON "message_delivery_receipts"("channel", "status", "sentAt");

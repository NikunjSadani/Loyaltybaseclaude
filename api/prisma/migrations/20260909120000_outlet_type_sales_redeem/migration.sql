-- Per-outlet-type sales-assisted redemption ("Redeem for Outlet") eligibility.
-- NULLABLE: "unset" (NULL) resolves to the preserve-today default (code = 'WHOLESALER')
-- in isSalesRedeemEnabledForPartner; an explicit true/false then wins everywhere.
ALTER TABLE "outlet_type_client_configs" ADD COLUMN "salesAssistedRedeemEnabled" BOOLEAN;

-- Migration: add_outlet_type_client_config
-- Adds the outlet_type_client_configs table for per-tenant feature flag configuration.

CREATE TABLE "outlet_type_client_configs" (
    "id"                 TEXT NOT NULL,
    "clientId"           TEXT NOT NULL,
    "outletTypeId"       TEXT NOT NULL,
    "isEnabled"          BOOLEAN NOT NULL DEFAULT true,
    "displayName"        TEXT,
    "loyaltyEnabled"     BOOLEAN NOT NULL DEFAULT true,
    "schemesEnabled"     BOOLEAN NOT NULL DEFAULT true,
    "visibilityEnabled"  BOOLEAN NOT NULL DEFAULT true,
    "payoutsEnabled"     BOOLEAN NOT NULL DEFAULT true,
    "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "targetsEnabled"     BOOLEAN NOT NULL DEFAULT true,
    "kycRequired"        BOOLEAN NOT NULL DEFAULT true,
    "metadata"           JSONB,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_type_client_configs_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one config row per client per outlet type
CREATE UNIQUE INDEX "outlet_type_client_configs_clientId_outletTypeId_key"
    ON "outlet_type_client_configs"("clientId", "outletTypeId");

-- Lookup indexes
CREATE INDEX "outlet_type_client_configs_clientId_idx"
    ON "outlet_type_client_configs"("clientId");

CREATE INDEX "outlet_type_client_configs_outletTypeId_idx"
    ON "outlet_type_client_configs"("outletTypeId");

-- FK: outletTypeId → outlet_types.id (cascade delete)
ALTER TABLE "outlet_type_client_configs"
    ADD CONSTRAINT "outlet_type_client_configs_outletTypeId_fkey"
    FOREIGN KEY ("outletTypeId")
    REFERENCES "outlet_types"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

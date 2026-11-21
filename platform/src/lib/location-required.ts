/**
 * THE single FE read of the tenant's "Require location" setting (`clients.features.requireLocation`;
 * docs/plans/LOCATION-GATE.md). Owner decision 2026-11-21: DEFAULT ON for every tenant — ON unless the key is
 * EXPLICITLY `false` (the Gifsy console's emergency off). Absent key / no features blob → ON.
 * Mirrors the API's `isLocationRequired` (api/src/common/location-gate.helper.ts).
 */
export function isLocationRequired(features: unknown): boolean {
  if (!features || typeof features !== 'object') return true;
  return (features as Record<string, unknown>).requireLocation !== false;
}

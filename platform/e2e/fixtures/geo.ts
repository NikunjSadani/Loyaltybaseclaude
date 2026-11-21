/**
 * Location gate fixture (features.requireLocation — DEFAULT ON for every tenant since 2026-11-21; LOCATION-GATE.md).
 *
 * E2E_GEO: the fixed position the sales-role projects run with (playwright.config.ts grants the geolocation permission
 * and sets this position). e2eBoardPhotoGeo(): a FRESH board-photo fix for API-level KYC creates — the server refuses a
 * sales rep's KYC without one (or with one older than 60 minutes), so it is built at call time, never hardcoded.
 */
export const E2E_GEO = { latitude: 19.076, longitude: 72.8777, accuracy: 10 };

export function e2eBoardPhotoGeo(now: Date = new Date()) {
  return { lat: E2E_GEO.latitude, lng: E2E_GEO.longitude, accuracy: E2E_GEO.accuracy, ts: now.toISOString() };
}

/* ─── Visibility Capture Mode API client ──────────────────────────────────────
   Reads the current mode from GET /api/admin/settings/config (features object)
   and writes it via PUT /api/admin/settings/visibility-capture-mode.

   GIFSY_ADMIN only — enforced on the backend (tenancy:manage_flags).
   Reads are permitted for GIFSY_ADMIN + CLIENT_ADMIN (via /config endpoint).
──────────────────────────────────────────────────────────────────────────────── */

export type VisibilityCaptureMode = 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';

// AF-6: auth rides the httpOnly cookie (same-origin fetch sends it); no JS token to attach.
function authHeader(): Record<string, string> {
  return {};
}

/**
 * Reads the current visibility capture mode for the caller's tenant.
 * Fetches from GET /api/admin/settings/config → features.visibilityCaptureMode.
 * Falls back to 'PHOTO_APPROVAL' (the default) if the field is absent or the
 * request fails — matches the backend's TenantService.resolveVisibilityCaptureMode.
 */
export async function fetchVisibilityCaptureMode(): Promise<VisibilityCaptureMode> {
  try {
    const res = await fetch('/api/admin/settings/config', {
      headers: { ...authHeader() },
    });
    if (!res.ok) return 'PHOTO_APPROVAL';
    const json = await res.json();
    const mode: unknown = json?.data?.features?.visibilityCaptureMode
      ?? json?.features?.visibilityCaptureMode;
    if (mode === 'PHOTO_APPROVAL' || mode === 'AMOUNT_UPLOAD') return mode;
    return 'PHOTO_APPROVAL';
  } catch {
    return 'PHOTO_APPROVAL';
  }
}

/**
 * Persists the visibility capture mode for the caller's tenant.
 * Calls PUT /api/admin/settings/visibility-capture-mode.
 * GIFSY_ADMIN only — the backend will return 403 for any other role.
 * Throws if the request fails (non-2xx).
 */
export async function saveVisibilityCaptureMode(mode: VisibilityCaptureMode): Promise<void> {
  const res = await fetch('/api/admin/settings/visibility-capture-mode', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to save mode (HTTP ${res.status})`);
  }
}

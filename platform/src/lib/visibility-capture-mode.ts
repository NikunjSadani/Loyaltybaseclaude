/* ─── Visibility Capture Mode API client ──────────────────────────────────────
   Reads the current mode from GET /api/admin/settings/features (features object)
   and writes it via PUT /api/admin/settings/visibility-capture-mode.

   GIFSY_ADMIN only — enforced on the backend (tenancy:manage_flags).
   Reads are permitted for GIFSY_ADMIN + CLIENT_ADMIN + assumed GIFSY_STAFF (via /features).
──────────────────────────────────────────────────────────────────────────────── */

export type VisibilityCaptureMode = 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';

// AF-6: auth rides the httpOnly cookie (same-origin fetch sends it); no JS token to attach.
function authHeader(): Record<string, string> {
  return {};
}

/** The read result: a known mode, or 'UNKNOWN' when the current mode could not be read. */
export type VisibilityCaptureModeRead = VisibilityCaptureMode | 'UNKNOWN';

/**
 * Reads the current visibility capture mode for the caller's tenant.
 * Fetches from GET /api/admin/settings/features → features.visibilityCaptureMode.
 * A features blob WITHOUT the field → 'PHOTO_APPROVAL' (that IS the backend default —
 * TenantService.resolveVisibilityCaptureMode). A FAILED read (network / non-2xx / bad body) or an
 * unrecognised stored value → 'UNKNOWN' — never a guessed PHOTO_APPROVAL (owner rule: no silent
 * fallback). The settings page must not let the mode be saved while it is UNKNOWN.
 */
export async function fetchVisibilityCaptureMode(): Promise<VisibilityCaptureModeRead> {
  try {
    // Flags-only read (same `features` blob as /api/admin/settings/config).
    const res = await fetch('/api/admin/settings/features', {
      headers: { ...authHeader() },
    });
    if (!res.ok) return 'UNKNOWN';
    const json = await res.json();
    const features: unknown = json?.data?.features ?? json?.features;
    if (!features || typeof features !== 'object') return 'UNKNOWN';
    const mode: unknown = (features as Record<string, unknown>).visibilityCaptureMode;
    if (mode === undefined || mode === null) return 'PHOTO_APPROVAL';
    if (mode === 'PHOTO_APPROVAL' || mode === 'AMOUNT_UPLOAD') return mode;
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
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

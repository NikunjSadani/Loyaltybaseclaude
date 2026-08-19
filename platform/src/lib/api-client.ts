/* ─── Central API Client ────────────────────────────────────────────────────
   Single fetch wrapper for all partner/admin pages.
   Consolidates the 3 duplicate authHeader() implementations in:
     - src/lib/banner.ts
     - src/lib/task-config.ts
     - src/lib/visibility-upload.ts

   Usage:
     import { api } from '@/lib/api-client'
     const result = await api.get<WalletBalance>('/api/wallet')
     if (result.success) { ... result.data ... }
─────────────────────────────────────────────────────────────────────────────── */

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * AF-6: auth is the httpOnly `token` cookie, which same-origin fetches send
 * automatically — the proxy reads it and injects the backend Bearer header. There
 * is no JS-readable token to attach, so this is now a no-op (kept for call-site
 * compatibility). Returns no headers.
 */
export function authHeader(): Record<string, string> {
  return {};
}

async function request<T>(url: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const method = init.method ?? 'GET';
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...authHeader(),
        ...(init.headers as Record<string, string> | undefined ?? {}),
      },
    });
    const body = await res.json();
    if (!res.ok) {
      // RBAC Option-X P6: a 403 with no explicit body error gets a clear default
      // message instead of a bare "Forbidden" status text. The backend is the real
      // enforcement; this only improves how api.* consumers surface a denial.
      if (res.status === 403) {
        return { success: false, error: body?.error ?? "You don't have permission to do that" };
      }
      return { success: false, error: body?.error ?? res.statusText };
    }
    return body as ApiResponse<T>;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export const api = {
  get:   <T>(url: string)                => request<T>(url),
  post:  <T>(url: string, body: unknown) => request<T>(url, { method: 'POST',   body: JSON.stringify(body) }),
  put:   <T>(url: string, body: unknown) => request<T>(url, { method: 'PUT',    body: JSON.stringify(body) }),
  patch: <T>(url: string, body: unknown) => request<T>(url, { method: 'PATCH',  body: JSON.stringify(body) }),
  del:   <T>(url: string)                => request<T>(url, { method: 'DELETE' }),
};

'use client';

/* ─── Admin App Adoption (REAL data) ─────────────────────────────────────────────
   100% wired to GET /api/admin/../push/adoption (proxy → backend /v1/push/adoption).
   Every number on this page comes from that endpoint — no hardcoded metric constants.
   Shows (1) Web Push notification opt-in (users / devices, by role + by OS) and
   (2) home-screen installs (users, by platform). Auth follows the same authHeader()
   + fetch + useEffect/useState pattern as the dashboard pages.
──────────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import { Bell, Smartphone, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';

const DARK_NAVY = '#1A1A2E';

/* ─── API response model (precise to the endpoint contract) ──────────────────── */

interface AdoptionData {
  clientId: string;
  subscribed: {
    users: number;
    devices: number;
    byRole: { role: string; users: number }[];
    byOs: { os: string; users: number }[];
  };
  installed: {
    users: number;
    byPlatform: { platform: string; users: number }[];
  };
}

const fmtInt = (n: number) => (n ?? 0).toLocaleString('en-IN');

/* ─── Small presentational pieces ────────────────────────────────────────────── */

function BreakdownList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; users: number }[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">No data</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-sm">
              <span className="text-gray-700 truncate mr-3">{r.label}</span>
              <span className="font-semibold text-gray-900 shrink-0">{fmtInt(r.users)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminAppAdoptionPage() {
  const [data, setData] = useState<AdoptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/push/adoption', { headers: { ...authHeader() } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        const json: unknown = await r.json();
        // The endpoint may return the bare shape or wrap it as { success, data }.
        const payload =
          json && typeof json === 'object' && 'data' in json
            ? (json as { data: AdoptionData }).data
            : (json as AdoptionData);
        if (!payload || typeof payload !== 'object' || !('subscribed' in payload)) {
          throw new Error('Empty or malformed response');
        }
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load app adoption');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Loading state ── */
  if (loading) {
    return (
      <div
        className="flex flex-col items-center justify-center py-32 text-gray-400"
        data-testid="app-adoption-loading"
      >
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Loading app adoption…</p>
      </div>
    );
  }

  /* ── Error / empty state — NEVER fabricated numbers ── */
  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
            App Adoption
          </h1>
        </div>
        <Card className="border border-red-100 shadow-sm rounded-2xl" data-testid="app-adoption-error">
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-8 h-8 text-red-500" />
            <p className="text-sm font-semibold text-red-600">Couldn&apos;t load app adoption</p>
            <p className="text-xs text-gray-500 max-w-md">
              {error ?? 'No data was returned by the server.'} Please refresh or try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { subscribed, installed } = data;
  const nothingYet =
    subscribed.users === 0 && subscribed.devices === 0 && installed.users === 0;

  return (
    <div className="space-y-6" data-testid="app-adoption">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: DARK_NAVY }}>
          App Adoption
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Push notification opt-ins &amp; home-screen installs across this brand
        </p>
      </div>

      {/* ── Empty state ── */}
      {nothingYet ? (
        <Card className="border border-gray-100 shadow-sm rounded-2xl" data-testid="app-adoption-empty">
          <CardContent className="py-16 flex flex-col items-center text-center gap-2">
            <Smartphone className="w-8 h-8 text-gray-300" />
            <p className="text-sm font-semibold text-gray-600">No installs or subscriptions yet</p>
            <p className="text-xs text-gray-400 max-w-md">
              Once users enable notifications or add the app to their home screen, their adoption
              will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Notifications enabled ── */}
          <Card className="border border-gray-100 shadow-sm rounded-2xl">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-indigo-100 shrink-0">
                  <Bell className="w-5 h-5 text-indigo-600" />
                </div>
                <CardTitle>Notifications enabled</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pb-6 space-y-5">
              <div className="flex items-end gap-3">
                <p className="text-4xl font-bold text-gray-900 leading-none">
                  {fmtInt(subscribed.users)}
                </p>
                <p className="text-sm text-gray-500 mb-0.5">users</p>
              </div>
              <p className="text-xs text-gray-400 -mt-3">
                across {fmtInt(subscribed.devices)} devices
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2 border-t border-gray-100">
                <BreakdownList
                  title="By role"
                  rows={subscribed.byRole.map((r) => ({ label: r.role, users: r.users }))}
                />
                <BreakdownList
                  title="By OS"
                  rows={subscribed.byOs.map((o) => ({ label: o.os, users: o.users }))}
                />
              </div>
            </CardContent>
          </Card>

          {/* ── Installed to home screen ── */}
          <Card className="border border-gray-100 shadow-sm rounded-2xl">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-emerald-100 shrink-0">
                  <Smartphone className="w-5 h-5 text-emerald-600" />
                </div>
                <CardTitle>Installed to home screen</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pb-6 space-y-5">
              <div className="flex items-end gap-3">
                <p className="text-4xl font-bold text-gray-900 leading-none">
                  {fmtInt(installed.users)}
                </p>
                <p className="text-sm text-gray-500 mb-0.5">users</p>
              </div>

              <div className="pt-2 border-t border-gray-100">
                <BreakdownList
                  title="By platform"
                  rows={installed.byPlatform.map((p) => ({ label: p.platform, users: p.users }))}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

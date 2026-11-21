'use client';

/* ─── Admin App Adoption (REAL data) ─────────────────────────────────────────────
   100% wired to GET /api/admin/../push/adoption (proxy → backend /v1/push/adoption).
   Every number on this page comes from that endpoint — no hardcoded metric constants.
   Shows (1) Web Push notification opt-in (users / devices, by role + by OS) and
   (2) home-screen installs (users, by platform). Auth follows the same authHeader()
   + fetch + useEffect/useState pattern as the dashboard pages.
   (3) "Download installed users (Excel)" → GET /api/push/adoption/installed-users
   (backend /v1/push/adoption/installed-users, export kind 'app-installed-users'),
   via the shared downloadOrQueue/useDownloadAction button state machine. Disabled (with the reason) when
   nobody has installed the app; a 404 "0 users matched these filters." is shown as a neutral note (no file).
──────────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import { Bell, Smartphone, Loader2, AlertCircle, Download } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { authHeader } from '@/lib/api-client';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

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
    /** pwa_install rows (one per user × platform). Optional so an older API build still renders. */
    devices?: number;
    byRole?: { role: string; users: number }[];
    byPlatform: { platform: string; users: number }[];
  };
}

const fmtInt = (n: number) => (n ?? 0).toLocaleString('en-IN');

/** Install platforms are stored upper-case; show them like the notifications card's OS names. */
const PLATFORM_LABEL: Record<string, string> = { ANDROID: 'Android', IOS: 'iOS', DESKTOP: 'Desktop', OTHER: 'Other' };

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

/* ─── Installed-users download ───────────────────────────────────────────────── */

const INSTALLED_USERS_URL = '/api/push/adoption/installed-users';

type RoleGroup = '' | 'sales' | 'partner' | 'admin';

/** URL for the installed-users Excel, with only the filters that were chosen. */
function installedUsersUrl(roleGroup: RoleGroup, since: string): string {
  const q = new URLSearchParams();
  if (roleGroup) q.set('roleGroup', roleGroup);
  if (since) q.set('since', since);
  const qs = q.toString();
  return qs ? `${INSTALLED_USERS_URL}?${qs}` : INSTALLED_USERS_URL;
}

/** The server answers 404 with this text when the filters match nobody (export kind 'app-installed-users'). */
const NO_MATCH_RE = /matched these filters/i;
const NO_MATCH_TEXT = '0 users matched these filters.';
const NO_INSTALLS_TEXT = 'No one has installed the app yet, so there is nothing to download.';

function InstalledUsersDownload({ installedUsers }: { installedUsers: number }) {
  const action = useDownloadAction();
  const [roleGroup, setRoleGroup] = useState<RoleGroup>('');
  const [since, setSince] = useState('');
  // "0 users matched" is an answer, not a failure — shown as a neutral note, and no file is saved.
  const [noMatch, setNoMatch] = useState(false);
  const empty = installedUsers <= 0;
  const controlsDisabled = empty || action.busy;

  const onDownload = async () => {
    setNoMatch(false);
    const outcome = await action.run(installedUsersUrl(roleGroup, since), {
      fallbackFileName: 'app-installed-users.xlsx',
      init: { headers: { ...authHeader() } },
    });
    if (outcome?.kind === 'error' && outcome.status === 404 && NO_MATCH_RE.test(outcome.message)) {
      action.reset();
      setNoMatch(true);
    }
  };

  return (
    <Card className="border border-gray-100 shadow-sm rounded-2xl" data-testid="installed-users-download">
      <CardContent className="py-4 space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="installed-users-role-group" className="text-xs font-semibold text-gray-500">
              Role group
            </label>
            <select
              id="installed-users-role-group"
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 bg-white"
              value={roleGroup}
              onChange={(e) => {
                setRoleGroup(e.target.value as RoleGroup);
                setNoMatch(false);
              }}
              disabled={controlsDisabled}
            >
              <option value="">All users</option>
              <option value="sales">Sales team</option>
              <option value="partner">Partners (outlets)</option>
              <option value="admin">Admins</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="installed-users-since" className="text-xs font-semibold text-gray-500">
              Installed since (optional)
            </label>
            <input
              id="installed-users-since"
              type="date"
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-800 bg-white"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setNoMatch(false);
              }}
              disabled={controlsDisabled}
            />
          </div>
          <button
            type="button"
            onClick={() => void onDownload()}
            disabled={empty || action.blocked}
            aria-busy={action.busy}
            aria-describedby={empty ? 'installed-users-empty' : undefined}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: DARK_NAVY }}
          >
            {action.busy ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="w-4 h-4" aria-hidden="true" />
            )}
            {downloadButtonLabel(action, 'Download installed users (Excel)')}
          </button>
        </div>
        {empty ? (
          <p id="installed-users-empty" className="text-xs text-gray-500" data-testid="installed-users-none">
            {NO_INSTALLS_TEXT}
          </p>
        ) : (
          <p className="text-xs text-gray-400">
            Includes everyone who opened the app as an installed app.
          </p>
        )}
        <p role="status" className="text-xs text-gray-600" data-testid="installed-users-no-match">
          {noMatch ? NO_MATCH_TEXT : ''}
        </p>
        <DownloadActionStatus action={action} />
      </CardContent>
    </Card>
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

      {/* ── Installed-users Excel download ── */}
      <InstalledUsersDownload installedUsers={installed.users} />

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
              {/* Same layout as "Notifications enabled" (owner 2026-11-21): devices line + By role + By OS. */}
              {typeof installed.devices === 'number' && (
                <p className="text-xs text-gray-400 -mt-3">
                  across {fmtInt(installed.devices)} devices
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2 border-t border-gray-100">
                <BreakdownList
                  title="By role"
                  rows={(installed.byRole ?? []).map((r) => ({ label: r.role, users: r.users }))}
                />
                <BreakdownList
                  title="By OS"
                  rows={installed.byPlatform.map((p) => ({ label: PLATFORM_LABEL[p.platform] ?? p.platform, users: p.users }))}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

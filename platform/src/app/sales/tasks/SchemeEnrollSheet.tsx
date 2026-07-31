'use client';

/**
 * SchemeEnrollSheet — REAL sales-assisted scheme enrollment (D28 / §5.4).
 *
 * A field rep:
 *   1. opens a scheme → the sheet loads the rep's REACHABLE TARGETS for it via
 *      `schemeApi.getSalesTargets(schemeId)`. That list is authoritative: it already
 *      includes matched roster rows, STANDALONE Excel roster rows (id + name, D19),
 *      and live-rule subtree outlets — each with its persistent enrollment status
 *      (NOT_ENROLLED / SUBMITTED / REJECTED). No more guessing outlets from
 *      `/api/sales/outlets`.
 *   2. picks a target → the scheme's form is rendered by the SHARED `SchemeFormRenderer`
 *      (mode `SALES`), passing `targetSchemeOutletId` for a roster row (matched OR
 *      standalone) or `targetOutletRef` for a live-rule outlet (the backend lazily
 *      rosters it),
 *   3. submits → the renderer calls `schemeApi.enroll`. A REJECTED target is a real
 *      re-submit (the enroll endpoint supersedes the rejected enrollment with a new
 *      version, D10) — the "Resubmit" affordance re-opens the same form.
 *
 * The renderer owns the real OTP send/verify, media/GPS capture, and validation —
 * this file only drives target selection + the schema fetch + success/read-back.
 *
 * DUAL-SOURCE + APPROVAL: `getSalesTargets` now returns each target's `prefillValues`
 * (Excel roster) + `outletFieldValues` (matched-outlet master fields) + `outletApproved`
 * + `ownerPhoneMasked`. This sheet merges the two prefill maps and threads the real
 * approval/owner-phone into the renderer, so a KYC-approved matched outlet pre-pins the
 * PHONE_OTP to the owner up-front. The backend still RE-PINS the OTP on send
 * (`otp-send` returns `locked` + `phoneMasked`) regardless — so it is fail-safe.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  X, ChevronLeft, CheckCircle2, UserCheck, Search, Loader2, AlertTriangle, Store,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { schemeApi } from '@/lib/schemes';
import type {
  AudienceConfig, EligibleScheme, EnrollmentFormSchema, EnrollResult, SalesTarget,
} from '@/lib/scheme-types';
import { SchemeFormRenderer } from '@/components/schemes/SchemeFormRenderer';

/** Per-target enrollment status recorded from a real enroll THIS session (read-back). */
export type SchemeEnrolledStatus = 'SUBMITTED' | 'REJECTED';
export type SchemeEnrolledMap = Record<string, SchemeEnrolledStatus>;

/** Stable per-target key for the session read-back map + list rendering. */
function targetKey(t: SalesTarget): string {
  return t.schemeOutletId ?? t.targetOutletRef ?? t.outletRef;
}

/** A short "kind" tag for the target row. */
function targetKind(t: SalesTarget): string {
  if (t.standalone) return 'Roster · standalone';
  if (t.schemeOutletId) return 'Roster';
  return 'New';
}

type View = 'pick' | 'form' | 'formless' | 'success';

export function SchemeEnrollSheet({
  scheme,
  enrolled,
  onEnrolled,
  onClose,
}: {
  scheme: EligibleScheme;
  /** targetKey → its current enrollment status recorded THIS session (fresh-enroll read-back). */
  enrolled: SchemeEnrolledMap;
  onEnrolled: (targetKey: string, status: SchemeEnrolledStatus) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>('pick');
  // null = loading; [] = loaded-empty. The rep's reachable targets for THIS scheme.
  const [targets, setTargets] = useState<SalesTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SalesTarget | null>(null);
  const [search, setSearch] = useState('');

  // The scheme's form schema — fetched lazily when a target is chosen. `null` = no
  // form configured (formless enroll); `undefined` = not yet loaded.
  const [schema, setSchema] = useState<EnrollmentFormSchema | null | undefined>(undefined);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Whether this scheme has a form at all (from the eligible summary — avoids a fetch
  // for formless schemes). `enrollmentForm` is null/undefined when none is configured.
  const hasForm = Boolean(scheme.enrollmentForm);

  // Enroller self-edit (audienceConfig.allowEnrollerEdit — a new key not yet on the
  // shared AudienceConfig type; read via a widening cast). When on, a rep can re-open
  // an already-SUBMITTED target to correct it. See the report for the best-effort caveat:
  // this reuses the pickTarget→form flow (submits via the shared renderer's enroll
  // supersede, like the existing REJECTED "Resubmit"), and the form re-opens with roster
  // prefill only — getSalesTargets carries no per-target formValues to pre-fill.
  // NOTE: sales-rep self-edit is intentionally DISABLED. This sheet re-opens the form via
  // pickTarget → the shared renderer, which carries only roster PREFILL (getSalesTargets
  // returns no prior formValues), so an "edit" here would risk overwriting a good submission
  // with blanks. The audienceConfig.allowEnrollerEdit flag still drives the OUTLET self-edit
  // (partner portal, which pre-fills from the full prior values via resubmit); a GIFSY admin
  // can edit any sales-filled enrollment. A safe rep-side edit needs a per-target formValues
  // source — deferred. See owner note.
  const allowEnrollerEdit = false;

  useEffect(() => {
    let cancelled = false;
    setTargets(null);
    setLoadError(null);
    schemeApi
      .getSalesTargets(scheme.id)
      .then((r) => {
        if (cancelled) return;
        if (r.success) setTargets(r.data.targets);
        else {
          setTargets([]);
          setLoadError(r.error);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTargets([]);
          setLoadError('Failed to load outlets for this scheme.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scheme.id]);

  // Effective status for a target — a fresh session enroll wins over the server read-back.
  const statusOf = (t: SalesTarget): SalesTarget['status'] => enrolled[targetKey(t)] ?? t.status;

  const filtered = useMemo(() => {
    const list = targets ?? [];
    const q = search.trim().toLowerCase();
    const rows = q
      ? list.filter(
          (t) => t.outletName.toLowerCase().includes(q) || t.outletRef.toLowerCase().includes(q),
        )
      : list;
    // Not-yet-enrolled first; enrolled/rejected pushed down.
    return [...rows].sort(
      (a, b) => Number(statusOf(a) !== 'NOT_ENROLLED') - Number(statusOf(b) !== 'NOT_ENROLLED'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, search, enrolled]);

  async function pickTarget(t: SalesTarget) {
    setSelected(t);
    setError(null);
    if (!hasForm) {
      setSchema(null);
      setView('formless');
      return;
    }
    setView('form');
    setSchema(undefined);
    setSchemaLoading(true);
    const res = await api.get<{ enrollmentForm: { formSchema: EnrollmentFormSchema } }>(
      `/api/schemes/${scheme.id}/enrollment-form`,
    );
    setSchemaLoading(false);
    const fetched = res.success ? (res.data.enrollmentForm?.formSchema ?? null) : null;
    if (fetched && Array.isArray(fetched.fields) && fetched.fields.length > 0) {
      setSchema(fetched);
    } else {
      // No form (404) or an empty form → a formless enroll rather than a blank screen.
      setSchema(null);
      setView('formless');
    }
  }

  /** The enroll subject for the chosen target — roster row vs live-rule outlet. */
  const targetSubject = (t: SalesTarget) =>
    t.schemeOutletId
      ? { targetSchemeOutletId: t.schemeOutletId }
      : { targetOutletRef: t.targetOutletRef ?? t.outletRef };

  function handleSubmitted(result: EnrollResult) {
    const status = (result.enrollment?.status as SchemeEnrolledStatus) ?? 'SUBMITTED';
    if (selected) onEnrolled(targetKey(selected), status);
    setView('success');
  }

  async function enrollFormless() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    const res = await schemeApi.enroll(scheme.id, {
      enrollmentMode: 'SALES',
      ...targetSubject(selected),
      formValues: {},
    });
    setSubmitting(false);
    if (res.success) {
      onEnrolled(
        targetKey(selected),
        (res.data.enrollment?.status as SchemeEnrolledStatus) ?? 'SUBMITTED',
      );
      setView('success');
    } else {
      setError(res.error);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-t-3xl max-h-[92dvh] flex flex-col overflow-hidden shadow-2xl">
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div className="px-5 pt-5 pb-4 border-b border-gray-100 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {(view === 'form' || view === 'formless') && (
                <button
                  onClick={() => { setView('pick'); setSelected(null); setError(null); }}
                  className="p-1.5 -ml-1.5 rounded-xl hover:bg-gray-100 text-gray-500 transition-colors shrink-0"
                  aria-label="Back to outlet list"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-[var(--brand-primary)] uppercase tracking-widest mb-0.5">
                  Activations / Tasks
                </p>
                <h2 className="text-base font-bold text-gray-900 leading-snug truncate">{scheme.name}</h2>
                {selected && view !== 'pick' && (
                  <p className="text-[12px] text-gray-400 mt-0.5 truncate">{selected.outletName}</p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 -mr-1 rounded-xl hover:bg-gray-100 text-gray-400 transition-colors shrink-0"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── VIEW: target picker ─────────────────────────────────────────────── */}
        {view === 'pick' && (
          <>
            <div className="px-5 pt-4 pb-2 shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search outlets by name or code…"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white"
                  autoComplete="off"
                />
              </div>
              <p className="text-[11px] text-gray-400 mt-2">Pick the outlet you are enrolling into this scheme.</p>
            </div>

            <div className="overflow-y-auto flex-1">
              {targets === null ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
                </div>
              ) : loadError ? (
                <div className="flex flex-col items-center gap-2 py-12 text-red-500">
                  <AlertTriangle className="h-8 w-8" />
                  <p className="text-sm">{loadError}</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-gray-400">
                  <UserCheck className="h-8 w-8" />
                  <p className="text-sm">
                    No reachable outlets for this scheme{search ? ' match that search' : ''}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50 pb-2">
                  {filtered.map((t) => {
                    const status = statusOf(t);
                    return (
                      <div key={targetKey(t)} className="flex items-center gap-3 px-5 py-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-gray-800 truncate">{t.outletName}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                            {t.outletRef} · {targetKind(t)}
                          </p>
                          {t.standalone && (
                            <p className="text-[10px] text-amber-600 mt-0.5 flex items-center gap-1">
                              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                              Standalone roster row — you&apos;ll enter any OTP number
                            </p>
                          )}
                          {status === 'REJECTED' && t.rejectionReason && (
                            <p className="text-[10px] text-red-500 mt-0.5 truncate">{t.rejectionReason}</p>
                          )}
                        </div>
                        {status === 'SUBMITTED' ? (
                          <div className="shrink-0 flex items-center gap-2">
                            <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full bg-emerald-50 text-emerald-700">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Enrolled
                            </span>
                            {allowEnrollerEdit && (
                              <button
                                onClick={() => pickTarget(t)}
                                className="text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-gray-100 text-gray-700 border border-gray-200 active:bg-gray-200 transition-colors"
                              >
                                Edit
                              </button>
                            )}
                          </div>
                        ) : status === 'REJECTED' ? (
                          <button
                            onClick={() => pickTarget(t)}
                            className="shrink-0 text-[12px] font-semibold px-3 py-1.5 rounded-xl bg-red-50 text-red-600 border border-red-200 active:bg-red-100 transition-colors"
                          >
                            Rejected · Resubmit
                          </button>
                        ) : (
                          <button
                            onClick={() => pickTarget(t)}
                            className="shrink-0 text-[12px] font-semibold px-3.5 py-1.5 rounded-xl bg-[var(--brand-primary)] text-white active:opacity-90 transition-opacity"
                          >
                            Enroll
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── VIEW: form (SchemeFormRenderer, mode SALES) ─────────────────────── */}
        {view === 'form' && selected && (
          <div className="overflow-y-auto flex-1 px-5 pt-4 pb-8">
            {schemaLoading || schema === undefined ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--brand-primary)]" />
              </div>
            ) : schema ? (
              <SchemeFormRenderer
                schema={schema}
                // Dual-source prefill (D13 + outletField): the matched-outlet master-field
                // values WIN over an Excel roster column of the same name (outletField beats
                // Excel — matches the backend pin precedence). The renderer resolves each field
                // via id → outletField → prefillKey against this merged map. (A form binding
                // BOTH prefillKey and outletField to the identical key name is not a real config.)
                prefill={{
                  ...(selected.prefillValues ?? {}),
                  ...(selected.outletFieldValues ?? {}),
                }}
                context={{
                  schemeId: scheme.id,
                  mode: 'SALES',
                  // Real per-target KYC-approval / owner phone from getSalesTargets — an approved
                  // matched outlet pre-pins the PHONE_OTP to the owner on file (D16); the backend
                  // still re-pins on send regardless.
                  outletApproved: selected.outletApproved ?? false,
                  ownerPhoneMasked: selected.ownerPhoneMasked ?? undefined,
                  ...targetSubject(selected),
                }}
                onSubmitted={handleSubmitted}
                onError={(msg) => setError(msg)}
              />
            ) : null}
            {error && (
              <p className="text-center text-[12px] text-red-500 font-medium mt-3">{error}</p>
            )}
          </div>
        )}

        {/* ── VIEW: formless enroll (no form configured) ──────────────────────── */}
        {view === 'formless' && selected && (
          <div className="overflow-y-auto flex-1 px-5 pt-6 pb-8">
            <div className="flex flex-col items-center gap-3 mb-6 text-center">
              <div className="w-14 h-14 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center">
                <Store className="h-7 w-7 text-[var(--brand-primary)]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800">Enroll {selected.outletName}</p>
                <p className="text-[12px] text-gray-400 mt-1">
                  This scheme collects no form data — confirm to enroll this outlet.
                </p>
              </div>
            </div>
            {error && <p className="text-center text-[12px] text-red-500 font-medium mb-3">{error}</p>}
            <button
              onClick={enrollFormless}
              disabled={submitting}
              className="w-full py-3 rounded-xl text-sm font-bold bg-[var(--brand-primary)] text-white disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? 'Enrolling…' : 'Confirm enrollment'}
            </button>
          </div>
        )}

        {/* ── VIEW: success ───────────────────────────────────────────────────── */}
        {view === 'success' && selected && (
          <div className="overflow-y-auto flex-1 px-5 pt-10 pb-8">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-bold text-gray-900">Enrolled</h3>
                <p className="text-[13px] text-gray-500 mt-1">
                  <span className="font-semibold text-gray-700">{selected.outletName}</span> is now enrolled
                  in {scheme.name}.
                </p>
              </div>
            </div>
            <div className="mt-8 flex gap-2">
              <button
                onClick={() => { setView('pick'); setSelected(null); setSearch(''); setError(null); }}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-gray-100 text-gray-700 active:bg-gray-200 transition-colors"
              >
                Enroll another outlet
              </button>
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-xl text-sm font-bold bg-[var(--brand-primary)] text-white active:opacity-90 transition-opacity"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SchemeEnrollSheet;

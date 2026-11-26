'use client';

/**
 * The Rule Builder — create a draft, edit a draft, or view a published/archived version read-only.
 *
 * Two columns: the typed builder (attachment → inputs → pipeline → output) on the left, and a sticky
 * live simulator on the right. Never shows raw JSON. Lifecycle: Save (create/update) → Publish (409
 * supersede conflict surfaced inline) → Archive. A published rule is read-only with "Edit as new version".
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Plus, Save, Rocket, Archive, Copy, AlertCircle, CheckCircle2, Loader2, Lock, Link2, Pencil, CopyPlus,
} from 'lucide-react';
import {
  getRule, createRule, updateRule, publishRule, archiveRule, listRules, renameRule,
} from '@/lib/points-engine/api';
import { useAdminSession } from '@/lib/admin-session';
import type {
  PointsRuleRow, RuleConfigDraft, PipelineNode, NodeType, RuleStatus, RuleInput, AwardType, RoundingSpec, EvaluationBasis,
} from '@/lib/points-engine/types';
import { NODE_META } from '@/lib/points-engine/types';
import {
  Field, NumberField, SelectField, TextField, StatusBadge, cardCls,
  blankDraft, rowToDraft, defaultNode, firstNumericVar, draftIssues, inputCls, labelCls,
  RULE_NAME_MAX, RULE_NAME_PLACEHOLDER, ruleNameIssue, duplicateRuleNameWarning, ruleTitle, creditFieldLabel,
  duplicateDraft, cleanRuleName, programCell,
} from './kit';
import { InputsCard } from './InputsCard';
import { NodeCard } from './NodeCard';
import { SimulatorPanel } from './SimulatorPanel';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { intersectAppliesTo, isUnscoped, type AppliesTo } from '@/lib/applies-to';
import {
  FACET_NOUN, kpiScopeOf, ruleScopeOf, scopeMismatches, type KpiScopeFieldsLike, type RuleAudienceLike,
} from '@/lib/kpi-scope-core';

/**
 * APPLIES-TO D5: mirrors the backend publish gate (points-engine.service assertKpiCodesExist), which checks ONLY the
 * rule's ATTACHED KPI (bonus-input KPIs are never checked). The rule's audience is computed exactly like the
 * backend `ruleAppliesTo` — attachment program / sub-program PLUS every HARD (`onFail: zero`) segmentFilter on
 * outlet type / program / sub-program (shared logic: `ruleScopeOf` in kpi-scope-core).
 *   • DISJOINT from the KPI scope → the backend refuses to publish (compute would SKIP every outlet).
 *   • PARTIAL overlap → publish is allowed, but outlets outside the KPI scope are skipped in compute.
 * Case-only spelling is NOT hinted here: the backend checks it against the LIVE outlet spellings (which this
 * builder does not have) and its 400 names the exact spelling to use — a hint from the settings-list / KPI-scope
 * spelling could point at the wrong one.
 * Non-blocking warning text, or null when the backend would accept it without skips.
 */
export function ruleKpiScopeWarning(
  kpiCode: string,
  kpiScope: AppliesTo | undefined,
  rule: RuleAudienceLike,
): string | null {
  if (!kpiScope || isUnscoped(kpiScope)) return null;
  const ruleScope = ruleScopeOf(rule);
  const mm = scopeMismatches(kpiScope, ruleScope);
  if (mm.length === 0) return null;
  const parts = mm.map((m) => `${FACET_NOUN[m.facet]} "${m.outside.join(', ')}" (the KPI applies only to ${m.kpiValues.join(', ')})`);
  if (intersectAppliesTo(ruleScope, kpiScope) === null) {
    return `KPI ${kpiCode} does not apply to this rule's ${parts.join(' or ')}. Outlets there are skipped in compute, and publishing will be refused until the rule and the KPI scope overlap.`;
  }
  return `KPI ${kpiCode} does not apply to this rule's ${parts.join(' or ')}. Outlets there are skipped in compute; the rest can earn.`;
}

/** First day (YYYY-MM-DD) of the FY quarter containing today — the default effective-from of a new quarterly rule. */
function currentQuarterStart(): string {
  const now = new Date();
  const m = now.getMonth() + 1;
  const first = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : 1;
  return `${now.getFullYear()}-${String(first).padStart(2, '0')}-01`;
}

// Node types grouped by disclosure level for the "Add step" menu.
const LEVEL_ORDER = ['Basic', 'Tiered', 'Conditional', 'Clamp', 'Advanced'] as const;
const NODE_TYPES = Object.keys(NODE_META) as NodeType[];

function SectionCard({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className={`${cardCls} p-5`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function AddStepMenu({ onAdd, disabled }: { onAdd: (t: NodeType) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" /> Add step
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
            {LEVEL_ORDER.map((level) => {
              const types = NODE_TYPES.filter((t) => NODE_META[t].level === level);
              if (types.length === 0) return null;
              return (
                <div key={level} className="mb-1.5 last:mb-0">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{level}</p>
                  {types.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        onAdd(t);
                        setOpen(false);
                      }}
                      className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-gray-50"
                    >
                      <span className="text-sm font-medium text-gray-900">{NODE_META[t].label}</span>
                      <span className="text-[11px] text-gray-400">{NODE_META[t].blurb}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function RuleBuilder({ ruleId, duplicateFromId }: { ruleId: string; duplicateFromId?: string }) {
  const router = useRouter();
  const isNew = ruleId === 'new';
  const session = useAdminSession();
  const isGifsyAdmin = session?.role === 'GIFSY_ADMIN';
  // "Duplicate rule": the source rule this NEW rule was pre-filled from (display only — never sent on save).
  const [duplicatedFrom, setDuplicatedFrom] = useState<{ title: string; ruleId: string; version: number } | null>(null);

  const [draft, setDraft] = useState<RuleConfigDraft>(() => blankDraft());
  const [status, setStatus] = useState<RuleStatus | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [storedRuleId, setStoredRuleId] = useState<string | null>(null);

  const [loading, setLoading] = useState(!isNew || !!duplicateFromId);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Unsaved-edits flag, distinct from `saved` (which is false on a fresh load too): true only after the
  // author mutates the draft, cleared on load / save / publish. Publish acts on the STORED row, so it is
  // blocked while there are unsaved edits.
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveMsg, setArchiveMsg] = useState<string | null>(null);

  const readOnly = status !== null && status !== 'draft';

  const load = useCallback(async () => {
    if (isNew) {
      if (!duplicateFromId) return;
      // Duplicate: pre-fill a NEW draft from the source rule. Nothing is saved until Save draft.
      setLoading(true);
      setLoadError(null);
      const src = await getRule(duplicateFromId);
      if (src.success) {
        setDraft(duplicateDraft(src.data));
        setDuplicatedFrom({ title: ruleTitle(src.data).title, ruleId: src.data.ruleId, version: src.data.version });
        setDirty(true);
      } else {
        setLoadError(`Couldn't load the rule to duplicate: ${src.error ?? 'not found'}`);
      }
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const res = await getRule(ruleId);
    if (res.success) {
      setDraft(rowToDraft(res.data));
      setStatus(res.data.status);
      setVersion(res.data.version);
      setStoredRuleId(res.data.ruleId);
      setDirty(false);
    } else {
      setLoadError(res.error ?? 'Failed to load rule');
    }
    setLoading(false);
  }, [isNew, ruleId, duplicateFromId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every rule in scope — only to warn when this name is already used by ANOTHER rule (duplicates are allowed).
  const [allRules, setAllRules] = useState<PointsRuleRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await listRules();
        if (!cancelled && res.success && Array.isArray(res.data)) setAllRules(res.data);
      } catch {
        /* no duplicate warning without the list — never blocks */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Rename (published / archived rules — no new version; display-only, audited server-side).
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameMsg, setRenameMsg] = useState<string | null>(null);
  const handleRename = async () => {
    const issue = ruleNameIssue(renameValue, true);
    if (issue) { setRenameError(issue); return; }
    setRenameBusy(true);
    setRenameError(null);
    setRenameMsg(null);
    const res = await renameRule(ruleId, cleanRuleName(renameValue));
    if (res.success) {
      setDraft((d) => ({ ...d, name: res.data.name ?? '' }));
      setAllRules((rs) => rs.map((r) => (r.ruleId === res.data.ruleId ? { ...r, name: res.data.name ?? null } : r)));
      setRenaming(false);
      setRenameMsg('Renamed — every version of this rule now shows the new name. The rule logic and version are unchanged.');
    } else {
      setRenameError(res.error ?? 'Rename failed');
    }
    setRenameBusy(false);
  };

  // ── Credit-field options for the Output dropdown (resolves the opaque field id → its name, so an
  //    author never has to discover/paste a cuid). Active fields only; a stored-but-now-inactive
  //    field on an existing rule is still shown so it isn't silently lost. ──
  const [creditFields, setCreditFields] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [creditFieldsLoaded, setCreditFieldsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/credits/fields');
        const json = await res.json();
        if (!cancelled && json?.success && Array.isArray(json.data)) {
          setCreditFields(
            (json.data as Array<{ id: string; name: string; isActive: boolean }>).map((f) => ({
              id: f.id, name: f.name, isActive: f.isActive,
            })),
          );
          setCreditFieldsLoaded(true);
        }
      } catch {
        /* leave empty — the Output field falls back to a "create a field first" prompt */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Attachment dropdown options (searchable) ──
  // Program + Sub-Program come from the tenant's configured lists (the same source as the outlet master
  // upload); KPI codes from the KPI catalogue. Each list also includes the draft's CURRENT value, so
  // editing an existing rule whose stored value is no longer in the list still shows + keeps it.
  const settings = useGifsySettings();
  const [kpiCodes, setKpiCodes] = useState<string[]>([]);
  const [kpiScopes, setKpiScopes] = useState<Record<string, AppliesTo>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/kpis');
        const json = await res.json();
        if (!cancelled && json?.success && Array.isArray(json.data)) {
          const rows = json.data as Array<{ code: string; enabled?: boolean } & KpiScopeFieldsLike>;
          setKpiCodes(rows.filter((k) => k.enabled !== false).map((k) => k.code));
          setKpiScopes(Object.fromEntries(rows.map((k) => [k.code, kpiScopeOf(k)])));
        }
      } catch {
        /* leave empty — KPI falls back to the draft's current value only */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const uniqOpts = (arr: (string | null | undefined)[]): string[] =>
    [...new Set(arr.filter((x): x is string => !!x && x.trim() !== ''))];
  const programOptions = uniqOpts([...(settings.outletPrograms ?? []), draft.attachsTo.program]);
  const categoryOptions = uniqOpts([...(settings.outletCategories ?? []), draft.attachsTo.programCategory]);
  const kpiOptions = uniqOpts([...kpiCodes, draft.attachsTo.kpiCode]);
  const kpiScopeWarning = ruleKpiScopeWarning(draft.attachsTo.kpiCode, kpiScopes[draft.attachsTo.kpiCode], {
    ...draft.attachsTo,
    pipeline: draft.pipeline,
  });

  // ── draft mutators ────────────────────────────────────────────────────────────
  const patch = (p: Partial<RuleConfigDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
    setDirty(true);
  };

  const setAttach = (p: Partial<RuleConfigDraft['attachsTo']>) => {
    setDraft((d) => {
      const nextAttach = { ...d.attachsTo, ...p };
      let inputs = d.inputs;
      // Keep the seeded `value` input in step with the attachment KPI while it still tracks it.
      if (p.kpiCode !== undefined && d.inputs[0]?.ref === 'value' && d.inputs[0].kpiCode != null) {
        const prev = d.attachsTo.kpiCode;
        if (d.inputs[0].kpiCode === '' || d.inputs[0].kpiCode === prev) {
          inputs = d.inputs.map((inp, i) => (i === 0 ? { ...inp, kpiCode: p.kpiCode } : inp));
        }
      }
      return { ...d, attachsTo: nextAttach, inputs };
    });
    setSaved(false);
    setDirty(true);
  };

  const setOutput = (p: Partial<RuleConfigDraft['output']>) => {
    setDraft((d) => {
      const output = { ...d.output, ...p };
      // A POINTS award must round to whole points — force scale 0.
      const rounding: RoundingSpec = output.awardType === 'POINTS' ? { ...d.rounding, scale: 0 } : d.rounding;
      return { ...d, output, rounding };
    });
    setSaved(false);
    setDirty(true);
  };

  const setInputs = (inputs: RuleInput[]) => patch({ inputs });

  // Monthly ↔ quarterly. Nothing is stripped silently: quarter-only settings (per-input month, narration, {m1}…
  // placeholders) stay on the draft and "Fix these before saving" lists each one while the rule is Monthly.
  // A brand-new quarterly rule defaults its effective-from to the first day of the current FY quarter.
  // The period is fixed once a rule has more than one version (publishing a version retires the earlier ones).
  const quarterly = draft.evaluationBasis === 'QUARTER';
  const basisLocked = version !== null && version > 1;
  const setBasis = (evaluationBasis: EvaluationBasis) => {
    setDraft((d) => ({
      ...d,
      evaluationBasis,
      ...(evaluationBasis === 'QUARTER' && isNew ? { effectiveFrom: currentQuarterStart() } : {}),
    }));
    setSaved(false);
    setDirty(true);
  };

  const setNode = (i: number, node: PipelineNode) =>
    patch({ pipeline: draft.pipeline.map((n, idx) => (idx === i ? node : n)) });

  const addNode = (t: NodeType) =>
    patch({ pipeline: [...draft.pipeline, defaultNode(t, firstNumericVar(draft.inputs))] });

  const moveNode = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.pipeline.length) return;
    const next = draft.pipeline.slice();
    [next[i], next[j]] = [next[j], next[i]];
    patch({ pipeline: next });
  };

  const removeNode = (i: number) => patch({ pipeline: draft.pipeline.filter((_, idx) => idx !== i) });

  // ── lifecycle ───────────────────────────────────────────────────────────────────
  const baseIssues = draftIssues(draft);
  // Name: REQUIRED for a new rule (soft — Save draft is blocked with a clear issue), optional for an existing one.
  const nameIssue = ruleNameIssue(draft.name, isNew);
  const nameDupWarning = duplicateRuleNameWarning(draft.name, storedRuleId ?? draft.ruleId ?? null, allRules);
  const issues = {
    blocking: nameIssue ? [nameIssue, ...baseIssues.blocking] : baseIssues.blocking,
    warnings: nameDupWarning ? [nameDupWarning, ...baseIssues.warnings] : baseIssues.warnings,
  };
  const canSave =
    draft.effectiveFrom.trim() !== '' &&
    draft.attachsTo.kpiCode.trim() !== '' &&
    draft.output.fieldId.trim() !== '' &&
    issues.blocking.length === 0;

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const res = isNew ? await createRule(draft) : await updateRule(ruleId, draft);
    if (res.success) {
      if (isNew) {
        router.push(`/admin/points-engine/rules/${res.data.id}`);
        return;
      }
      setDraft(rowToDraft(res.data));
      setStatus(res.data.status);
      setVersion(res.data.version);
      setSaved(true);
      setDirty(false);
    } else {
      setSaveError(res.error ?? 'Save failed');
    }
    setSaving(false);
  };

  const handlePublish = async () => {
    if (isNew) return;
    setPublishing(true);
    setPublishError(null);
    const res = await publishRule(ruleId);
    if (res.success) {
      // Refresh the editor from the publish response so the on-screen config matches what is now live.
      setDraft(rowToDraft(res.data));
      setStatus(res.data.status);
      setVersion(res.data.version);
      setSaved(false);
      setDirty(false);
    } else {
      setPublishError(
        res.status === 409
          ? `Can't publish — a conflicting published rule exists for this attachment/window: ${res.error}`
          : res.error ?? 'Publish failed',
      );
    }
    setPublishing(false);
  };

  const handleArchive = async () => {
    if (isNew) return;
    // A draft never resolves in a compute run, so the "stop applying to new runs" copy is wrong for it.
    const confirmMsg =
      status === 'draft'
        ? 'Archive this draft? It will be removed from the active list and can no longer be published.'
        : 'Archive this rule? It will stop applying to new compute runs.';
    if (!confirm(confirmMsg)) return;
    setArchiving(true);
    setArchiveError(null);
    setArchiveMsg(null);
    const res = await archiveRule(ruleId);
    if (res.success) {
      setStatus(res.data.status);
      setArchiveMsg('Rule archived.');
    } else {
      setArchiveError(res.error ?? 'Archive failed');
    }
    setArchiving(false);
  };

  const handleEditAsNewVersion = async () => {
    setSaving(true);
    setSaveError(null);
    // Carry the same ruleId → the backend mints version+1 as a fresh draft. Default the new version's
    // effective-from to TODAY (the author can change it) so publishing it doesn't collapse the prior
    // published version to a 1-day window by reusing its effectiveFrom.
    // A QUARTERLY version pays a quarter only if it starts on or before the quarter's first day, so it defaults to the
    // current quarter's first day (back-dating is allowed; the author can change it).
    const today = new Date().toISOString().slice(0, 10);
    const from = draft.evaluationBasis === 'QUARTER' ? currentQuarterStart() : today;
    const res = await createRule({ ...draft, ruleId: storedRuleId ?? draft.ruleId, effectiveFrom: from });
    if (res.success) {
      router.push(`/admin/points-engine/rules/${res.data.id}`);
      return;
    }
    setSaveError(res.error ?? 'Could not start a new version');
    setSaving(false);
  };

  // ── render ────────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rule…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">Couldn&apos;t load this rule</p>
            <p className="mt-0.5">{loadError}</p>
            <button onClick={() => void load()} className="mt-2 font-semibold text-red-800 underline">
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const shownTitle = ruleTitle({ name: draft.name });
  const title = isNew ? (cleanRuleName(draft.name) || 'New rule') : shownTitle.title;
  // ruleId is shown small: always for an unnamed rule (it is the only handle), and to Gifsy admins for every rule.
  const showRuleId = !isNew && !!storedRuleId && (shownTitle.unnamed || isGifsyAdmin);
  const openDuplicate = () => {
    if (dirty && !confirm('You have unsaved changes. The copy is made from the SAVED version of this rule — continue?')) return;
    router.push(`/admin/points-engine/rules/new?from=${encodeURIComponent(ruleId)}`);
  };

  return (
    <div className="space-y-5 pb-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/admin/points-engine/rules" className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className={`text-xl font-bold ${!isNew && shownTitle.unnamed ? 'italic text-gray-500' : 'text-gray-900'}`} data-testid="rule-title">
                {title}
              </h1>
              {status && <StatusBadge status={status} />}
              {version !== null && <span className="text-xs font-semibold text-gray-400">v{version}</span>}
            </div>
            {showRuleId && (
              <p className="font-mono text-[10px] text-gray-400" data-testid="rule-id-small">{storedRuleId}</p>
            )}
            {!isNew && (
              <p className="mt-0.5 text-xs text-gray-600" data-testid="rule-attachment-summary">
                Program <span className="font-semibold">{programCell(draft.attachsTo.program)}</span>
                {' · '}Sub-programme <span className="font-semibold">{programCell(draft.attachsTo.programCategory)}</span>
                {' · '}KPI <span className="font-mono font-semibold">{draft.attachsTo.kpiCode || '—'}</span>
              </p>
            )}
            <p className="mt-0.5 text-xs text-gray-500">
              {isNew
                ? 'Define the attachment, inputs and point pipeline. Save a draft, then publish.'
                : readOnly
                  ? 'This version is read-only. Edit it as a new version to make changes.'
                  : 'Draft — edit, simulate, then publish when ready.'}
            </p>
          </div>
        </div>

        {/* Lifecycle actions */}
        <div className="flex flex-wrap items-center gap-2">
          {readOnly ? (
            <>
              {status === 'published' && (
                <button
                  type="button"
                  onClick={() => void handleEditAsNewVersion()}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  Edit as new version
                </button>
              )}
              <button
                type="button"
                onClick={openDuplicate}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
              >
                <CopyPlus className="h-4 w-4" /> Duplicate rule
              </button>
              {status !== 'archived' && (
                <button
                  type="button"
                  onClick={() => void handleArchive()}
                  disabled={archiving}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
                >
                  <Archive className="h-4 w-4" /> Archive
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !canSave}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isNew ? 'Save draft' : 'Save changes'}
              </button>
              {!isNew && (
                <>
                  <button
                    type="button"
                    onClick={() => void handlePublish()}
                    disabled={publishing || dirty}
                    title={dirty ? 'Save your changes before publishing.' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-[var(--brand-primary)] transition hover:bg-[var(--brand-primary)]/5 disabled:opacity-60"
                  >
                    {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                    Publish
                  </button>
                  <button
                    type="button"
                    onClick={openDuplicate}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                  >
                    <CopyPlus className="h-4 w-4" /> Duplicate rule
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleArchive()}
                    disabled={archiving}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
                  >
                    <Archive className="h-4 w-4" /> Archive
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Status banners */}
      {saved && (
        <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> Saved.
        </div>
      )}
      {saveError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {saveError}
        </div>
      )}
      {!readOnly && issues.blocking.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertCircle className="h-4 w-4 shrink-0" /> Fix these before saving
          </p>
          <ul className="ml-6 list-disc space-y-0.5 text-xs">
            {issues.blocking.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {!readOnly && issues.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="mb-1 flex items-center gap-2 font-semibold">
            <AlertCircle className="h-4 w-4 shrink-0" /> Heads up
          </p>
          <ul className="ml-6 list-disc space-y-0.5 text-xs">
            {issues.warnings.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {!readOnly && !isNew && dirty && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" /> Save your changes before publishing.
        </div>
      )}
      {publishError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {publishError}
        </div>
      )}
      {archiveError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {archiveError}
        </div>
      )}
      {archiveMsg && (
        <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {archiveMsg}
        </div>
      )}
      {readOnly && (
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-600">
          <Lock className="h-4 w-4 shrink-0" />
          {status === 'published'
            ? 'Published versions are immutable. Use “Edit as new version” to change the logic.'
            : 'This rule is archived and read-only.'}
        </div>
      )}

      {duplicatedFrom && (
        <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-800" data-testid="duplicate-banner">
          <CopyPlus className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Duplicating <span className="font-semibold">{duplicatedFrom.title}</span>{' '}
            <span className="font-mono text-[11px] text-sky-600">({duplicatedFrom.ruleId} v{duplicatedFrom.version})</span>. This is a
            NEW rule — the original is unchanged, and nothing is saved until you click Save draft.
          </span>
        </div>
      )}

      {/* Rule name (display-only — never changes what the rule pays) */}
      <section className={`${cardCls} p-5`} data-testid="rule-name-card">
        {!readOnly ? (
          <Field
            label="Rule name"
            required={isNew}
            hint={`Shown in the rules list, compute preview and reports (max ${RULE_NAME_MAX} characters). Changing it never changes what the rule pays.`}
          >
            <input
              value={draft.name ?? ''}
              placeholder={RULE_NAME_PLACEHOLDER}
              aria-label="Rule name"
              onChange={(e) => patch({ name: e.target.value })}
              className={inputCls}
            />
          </Field>
        ) : renaming ? (
          <div className="space-y-2">
            <Field label="Rule name" hint="Renaming does not create a new version and never changes what the rule pays.">
              <input
                value={renameValue}
                placeholder={RULE_NAME_PLACEHOLDER}
                aria-label="New rule name"
                autoFocus
                onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); if (e.key === 'Escape') setRenaming(false); }}
                className={inputCls}
              />
            </Field>
            {(() => {
              const w = duplicateRuleNameWarning(renameValue, storedRuleId, allRules);
              return w ? <p className="text-xs text-amber-700" role="status">{w}</p> : null;
            })()}
            {renameError && <p className="text-xs text-red-600" role="alert">{renameError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleRename()}
                disabled={renameBusy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-primary)] px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {renameBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save name
              </button>
              <button
                type="button"
                onClick={() => { setRenaming(false); setRenameError(null); }}
                className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={labelCls}>Rule name</p>
              <p className={`text-sm ${shownTitle.unnamed ? 'italic text-gray-400' : 'font-semibold text-gray-900'}`}>{shownTitle.title}</p>
            </div>
            <button
              type="button"
              onClick={() => { setRenameValue(draft.name ?? ''); setRenaming(true); setRenameMsg(null); }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-gray-50"
            >
              <Pencil className="h-3.5 w-3.5" /> Rename
            </button>
          </div>
        )}
        {renameMsg && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-green-700" role="status">
            <CheckCircle2 className="h-3.5 w-3.5" /> {renameMsg}
          </p>
        )}
      </section>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Left — builder */}
        <div className="space-y-5 lg:col-span-2">
          {/* Attachment */}
          <SectionCard
            title="Attachment"
            subtitle="Which program × KPI this rule applies to, and when it is effective."
            right={<Link2 className="h-4 w-4 text-gray-300" />}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Program" hint="Pick a configured program, or leave blank to match any.">
                <SearchableSelect
                  value={draft.attachsTo.program ?? ''}
                  options={programOptions}
                  disabled={readOnly}
                  placeholder="(any)"
                  aria-label="Program"
                  testIdPrefix="rule-program"
                  className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
                  onChange={(v) => setAttach({ program: v || null })}
                />
              </Field>
              <Field label="Sub-Program" hint="Pick a configured sub-program, or leave blank.">
                <SearchableSelect
                  value={draft.attachsTo.programCategory ?? ''}
                  options={categoryOptions}
                  disabled={readOnly}
                  placeholder="(any)"
                  aria-label="Sub-Program"
                  testIdPrefix="rule-subprogram"
                  className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
                  onChange={(v) => setAttach({ programCategory: v || null })}
                />
              </Field>
              <Field label="KPI code" required hint="Pick from the KPI catalogue (reconciled at publish).">
                <SearchableSelect
                  value={draft.attachsTo.kpiCode}
                  options={kpiOptions}
                  disabled={readOnly}
                  placeholder="Select a KPI"
                  aria-label="KPI code"
                  testIdPrefix="rule-kpi"
                  className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-400`}
                  onChange={(v) => setAttach({ kpiCode: v })}
                />
              </Field>
              <Field
                label="Rule period"
                hint={
                  basisLocked
                    ? 'Fixed: a rule cannot switch between monthly and quarterly across versions. Create a new rule for a quarterly bonus.'
                    : quarterly
                      ? 'Computed only in a quarter run (FY quarters Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar). Inputs read month 1 / 2 / 3 of the quarter or the quarter total.'
                      : 'Computed in each monthly run.'
                }
              >
                <SelectField<EvaluationBasis>
                  value={draft.evaluationBasis ?? 'PERIOD_AGGREGATE'}
                  disabled={readOnly || basisLocked}
                  onChange={setBasis}
                  options={[
                    { value: 'PERIOD_AGGREGATE', label: 'Monthly' },
                    { value: 'QUARTER', label: 'Quarterly (financial-year quarter)' },
                  ]}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Effective from"
                  required
                  hint={
                    quarterly
                      ? "A quarterly rule pays a quarter only if it starts on or before the quarter's first day (1 Apr / 1 Jul / 1 Oct / 1 Jan) and runs to its end — a version starting mid-quarter does NOT pay that quarter. Back-dating is allowed."
                      : undefined
                  }
                >
                  <input
                    type="date"
                    value={draft.effectiveFrom}
                    disabled={readOnly}
                    onChange={(e) => patch({ effectiveFrom: e.target.value })}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </Field>
                <Field label="Effective to" hint="Blank = open-ended.">
                  <input
                    type="date"
                    value={draft.effectiveTo ?? ''}
                    disabled={readOnly}
                    min={draft.effectiveFrom || undefined}
                    onChange={(e) => patch({ effectiveTo: e.target.value || null })}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </Field>
              </div>
            </div>
            {kpiScopeWarning && (
              <div role="status" data-testid="rule-kpi-scope-warning"
                className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {kpiScopeWarning}
              </div>
            )}
          </SectionCard>

          {/* Inputs */}
          <SectionCard title="Inputs" subtitle="The variables the pipeline can read. The null policy decides what happens when a value is missing.">
            <InputsCard inputs={draft.inputs} disabled={readOnly} onChange={setInputs} quarterly={quarterly} />
          </SectionCard>

          {/* Pipeline */}
          <SectionCard
            title="Point pipeline"
            subtitle="Steps run top-to-bottom: gates & filters first, then accruals, then floor and cap."
            right={!readOnly ? <AddStepMenu onAdd={addNode} disabled={readOnly} /> : undefined}
          >
            {draft.pipeline.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 py-10 text-center">
                <Plus className="h-6 w-6 text-gray-300" />
                <p className="text-sm font-semibold text-gray-400">No steps yet</p>
                <p className="text-xs text-gray-400">Add a Rate to pay per unit, or a Slab for tiers.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {draft.pipeline.map((node, i) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    index={i}
                    total={draft.pipeline.length}
                    inputs={draft.inputs}
                    disabled={readOnly}
                    onChange={(n) => setNode(i, n)}
                    onMove={(dir) => moveNode(i, dir)}
                    onRemove={() => removeNode(i)}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          {/* Output */}
          <SectionCard title="Output" subtitle="Where the computed points land, and how they round.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Award type">
                <SelectField<AwardType>
                  value={draft.output.awardType}
                  disabled={readOnly}
                  onChange={(awardType) => setOutput({ awardType })}
                  options={[
                    { value: 'POINTS', label: 'Points' },
                    { value: 'PAYOUT', label: 'Payout' },
                  ]}
                />
              </Field>
              <Field label="Credit field" required hint="The credit bucket the points feed.">
                {(() => {
                  const active = creditFields.filter((f) => f.isActive);
                  const selected = creditFields.find((f) => f.id === draft.output.fieldId);
                  const selectedMissing = draft.output.fieldId !== '' && !active.some((f) => f.id === draft.output.fieldId);
                  if (readOnly) {
                    const fl = creditFieldsLoaded ? creditFieldLabel(draft.output.fieldId, creditFields) : null;
                    return (
                      <div
                        data-testid="rule-output-field"
                        className={`w-full rounded-xl border px-3 py-2 text-sm ${
                          fl?.problem ? 'border-red-200 bg-red-50 font-semibold text-red-700' : 'border-gray-200 bg-gray-50 text-gray-600'
                        }`}
                      >
                        {fl ? fl.label : selected?.name ?? (draft.output.fieldId || '—')}
                      </div>
                    );
                  }
                  if (active.length === 0 && !selectedMissing) {
                    return (
                      <p className="text-xs text-gray-500">
                        No credit fields yet —{' '}
                        <Link href="/admin/credits-payouts/fields" className="font-medium text-[var(--brand-primary)] underline">
                          create one in Credits &amp; Payouts → Fields
                        </Link>{' '}first.
                      </p>
                    );
                  }
                  return (
                    <SelectField<string>
                      value={draft.output.fieldId}
                      disabled={readOnly}
                      onChange={(fieldId) => setOutput({ fieldId })}
                      options={[
                        { value: '', label: 'Select a credit field…' },
                        ...active.map((f) => ({ value: f.id, label: f.name })),
                        ...(selectedMissing
                          ? [{ value: draft.output.fieldId, label: `${selected?.name ?? draft.output.fieldId} (inactive)` }]
                          : []),
                      ]}
                    />
                  );
                })()}
              </Field>

              {(quarterly || !!draft.output.narration) && (
                <Field
                  label="Credit narration"
                  className="sm:col-span-2"
                  hint="Shown on each credit; the quarter is added automatically, e.g. “Consistency bonus” → “Consistency bonus Oct–Dec 2026”. Blank = “Quarterly points Oct–Dec 2026”."
                >
                  <TextField
                    value={draft.output.narration ?? ''}
                    disabled={readOnly}
                    placeholder="Consistency bonus"
                    onChange={(v) => setOutput({ narration: v === '' ? undefined : v.slice(0, 100) })}
                  />
                </Field>
              )}
              {draft.output.awardType === 'PAYOUT' && (
                <div className="sm:col-span-2 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  PAYOUT rules aren&apos;t creditable by the compute preview yet — those rows are demoted to review.
                </div>
              )}

              <Field label="Rounding mode">
                <SelectField<RoundingSpec['mode']>
                  value={draft.rounding.mode}
                  disabled={readOnly}
                  onChange={(mode) => patch({ rounding: { ...draft.rounding, mode } })}
                  options={[
                    { value: 'half_up', label: 'Half up' },
                    { value: 'half_even', label: 'Half even (banker’s)' },
                    { value: 'floor', label: 'Floor (down)' },
                    { value: 'ceil', label: 'Ceil (up)' },
                  ]}
                />
              </Field>
              <Field label="Decimal places" hint={draft.output.awardType === 'POINTS' ? 'Points are whole — fixed at 0.' : 'Up to 6.'}>
                {draft.output.awardType === 'POINTS' ? (
                  <input value={0} disabled className="w-full rounded-xl border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-400" />
                ) : (
                  <NumberField
                    value={draft.rounding.scale}
                    disabled={readOnly}
                    min={0}
                    onChange={(scale) => patch({ rounding: { ...draft.rounding, scale: Math.max(0, Math.min(6, Math.round(scale))) } })}
                  />
                )}
              </Field>
            </div>
          </SectionCard>
        </div>

        {/* Right — sticky simulator */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-4">
            <SimulatorPanel draft={draft} />
          </div>
        </div>
      </div>
    </div>
  );
}

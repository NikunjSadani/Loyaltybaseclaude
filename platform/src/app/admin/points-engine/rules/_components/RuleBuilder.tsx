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
  ArrowLeft, Plus, Save, Rocket, Archive, Copy, AlertCircle, CheckCircle2, Loader2, Lock, Link2,
} from 'lucide-react';
import {
  getRule, createRule, updateRule, publishRule, archiveRule,
} from '@/lib/points-engine/api';
import type {
  RuleConfigDraft, PipelineNode, NodeType, RuleStatus, RuleInput, AwardType, RoundingSpec,
} from '@/lib/points-engine/types';
import { NODE_META } from '@/lib/points-engine/types';
import {
  Field, TextField, NumberField, SelectField, StatusBadge, cardCls,
  blankDraft, rowToDraft, defaultNode, firstNumericVar, draftIssues,
} from './kit';
import { InputsCard } from './InputsCard';
import { NodeCard } from './NodeCard';
import { SimulatorPanel } from './SimulatorPanel';

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

export function RuleBuilder({ ruleId }: { ruleId: string }) {
  const router = useRouter();
  const isNew = ruleId === 'new';

  const [draft, setDraft] = useState<RuleConfigDraft>(() => blankDraft());
  const [status, setStatus] = useState<RuleStatus | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [storedRuleId, setStoredRuleId] = useState<string | null>(null);

  const [loading, setLoading] = useState(!isNew);
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
    if (isNew) return;
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
  }, [isNew, ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

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
  const issues = draftIssues(draft);
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
    const today = new Date().toISOString().slice(0, 10);
    const res = await createRule({ ...draft, ruleId: storedRuleId ?? draft.ruleId, effectiveFrom: today });
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

  const title = isNew ? 'New rule' : storedRuleId ?? draft.ruleId ?? 'Rule';

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
              <h1 className="text-xl font-bold text-gray-900">{title}</h1>
              {status && <StatusBadge status={status} />}
              {version !== null && <span className="text-xs font-semibold text-gray-400">v{version}</span>}
            </div>
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
              <Field label="Program" hint="Leave blank to match any program.">
                <TextField
                  value={draft.attachsTo.program ?? ''}
                  disabled={readOnly}
                  placeholder="(any)"
                  onChange={(v) => setAttach({ program: v || null })}
                />
              </Field>
              <Field label="Sub-Program" hint="Optional sub-segment.">
                <TextField
                  value={draft.attachsTo.programCategory ?? ''}
                  disabled={readOnly}
                  placeholder="(any)"
                  onChange={(v) => setAttach({ programCategory: v || null })}
                />
              </Field>
              <Field label="KPI code" required hint="Reconciled against the KPI catalogue at publish.">
                <TextField
                  value={draft.attachsTo.kpiCode}
                  disabled={readOnly}
                  upper
                  placeholder="CASES_SOLD"
                  onChange={(v) => setAttach({ kpiCode: v })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Effective from" required>
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
          </SectionCard>

          {/* Inputs */}
          <SectionCard title="Inputs" subtitle="The variables the pipeline can read. The null policy decides what happens when a value is missing.">
            <InputsCard inputs={draft.inputs} disabled={readOnly} onChange={setInputs} />
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
              <Field label="Credit field id" required hint="The credit bucket the points feed.">
                <TextField
                  value={draft.output.fieldId}
                  disabled={readOnly}
                  placeholder="cf_scheme_q3"
                  onChange={(fieldId) => setOutput({ fieldId })}
                />
              </Field>

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

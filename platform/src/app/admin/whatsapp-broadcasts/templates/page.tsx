'use client';

/**
 * /admin/whatsapp-broadcasts/templates — per-tenant WhatsApp template library
 * (Gifsy-operator only). CRUD: name, MSG91 template name, category, language,
 * body with {{n}}, variable labels; soft-archive / restore.
 *
 * Contract: GET/POST/PATCH/DELETE /api/admin/whatsapp-templates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Plus,
  Loader2,
  AlertTriangle,
  Pencil,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  XCircle,
  BookText,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import {
  type WhatsappTemplate,
  type TemplateFormValues,
  type TemplateCategory,
  type TemplateVariable,
  TEMPLATE_CATEGORIES,
  emptyTemplateForm,
  validateTemplateForm,
  extractVariableIndexes,
  contractHint,
  categoryCostNote,
} from '@/lib/whatsapp-broadcasts';

export default function TemplateLibraryPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<WhatsappTemplate[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  const [editing, setEditing] = useState<WhatsappTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<WhatsappTemplate[] | { items: WhatsappTemplate[] }>(
      '/api/admin/whatsapp-templates',
    );
    if (res.success) {
      const data = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      setItems(data);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => items.filter((t) => (showArchived ? true : t.status === 'ACTIVE')),
    [items, showArchived],
  );

  async function handleArchiveToggle(t: WhatsappTemplate) {
    const res =
      t.status === 'ACTIVE'
        ? await api.del(`/api/admin/whatsapp-templates/${t.id}`)
        : await api.patch(`/api/admin/whatsapp-templates/${t.id}`, { status: 'ACTIVE' });
    if (res.success) {
      showToast(t.status === 'ACTIVE' ? 'Template archived.' : 'Template restored.');
      void load();
    } else {
      showToast(res.error, 'error');
    }
  }

  return (
    <div className="space-y-5 fade-in max-w-4xl">
      <Link
        href="/admin/whatsapp-broadcasts"
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All broadcasts
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <BookText className="w-5 h-5 text-[var(--brand-primary)]" />
            WhatsApp template library
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Manage the approved templates available to broadcasts. Only active templates can
            be sent.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          data-testid="new-template-btn"
          className="inline-flex items-center gap-2 text-xs px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26]"
        >
          <Plus className="w-3.5 h-3.5" />
          New template
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]/30"
        />
        Show archived templates
      </label>

      {loading && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
          Loading templates…
        </div>
      )}

      {!loading && error && (
        <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-12 text-center text-sm">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <div className="border border-gray-200 bg-white rounded-xl px-4 py-16 text-center">
          <BookText className="w-6 h-6 text-gray-300 mx-auto mb-2" />
          <h3 className="text-base font-semibold text-gray-900">No templates yet</h3>
          <p className="text-sm text-gray-500 mt-1">
            Create your first WhatsApp template to start broadcasting.
          </p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 text-xs px-4 py-2 mt-4 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26]"
          >
            <Plus className="w-3.5 h-3.5" />
            New template
          </button>
        </div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((t) => (
            <div
              key={t.id}
              className={`border rounded-xl p-4 ${
                t.status === 'ARCHIVED' ? 'border-gray-200 bg-gray-50 opacity-75' : 'border-gray-200 bg-white'
              }`}
              data-testid={`tpl-row-${t.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                    {t.name}
                    {t.status === 'ARCHIVED' && (
                      <span className="text-[10px] font-medium text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">
                        Archived
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] font-mono text-gray-400 mt-0.5">
                    {t.msg91TemplateName} · {t.category} · {t.languageCode}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing(t)}
                    data-testid={`edit-${t.id}`}
                    className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
                    aria-label={`Edit ${t.name}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => void handleArchiveToggle(t)}
                    data-testid={`archive-${t.id}`}
                    className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
                    aria-label={t.status === 'ACTIVE' ? `Archive ${t.name}` : `Restore ${t.name}`}
                  >
                    {t.status === 'ACTIVE' ? (
                      <Archive className="w-3.5 h-3.5" />
                    ) : (
                      <ArchiveRestore className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
              <pre className="mt-3 whitespace-pre-wrap text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-lg p-3 font-sans">
                {t.bodyText}
              </pre>
              <p className="text-[11px] text-gray-500 mt-2">
                Variables:{' '}
                <span className="font-medium text-gray-700">
                  {contractHint(t.variableContract)}
                </span>
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Create / edit modal */}
      {(creating || editing) && (
        <TemplateEditor
          initial={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(msg) => {
            setCreating(false);
            setEditing(null);
            showToast(msg);
            void load();
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[70] flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg"
        >
          {toast.type === 'error' ? (
            <XCircle className="w-4 h-4 text-red-400" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          )}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Editor modal ───────────────────────────────────────────────────────────────

function TemplateEditor({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: WhatsappTemplate | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<TemplateFormValues>(() =>
    initial
      ? {
          name: initial.name,
          msg91TemplateName: initial.msg91TemplateName,
          category: initial.category,
          languageCode: initial.languageCode,
          bodyText: initial.bodyText,
          variableContract: initial.variableContract,
        }
      : emptyTemplateForm(),
  );
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  // Auto-reconcile the variable contract with the {{n}} placeholders in the body:
  // add rows for new indexes (keeping any label already typed), drop removed ones.
  useEffect(() => {
    const indexes = extractVariableIndexes(form.bodyText);
    const byIndex = new Map(form.variableContract.map((v) => [v.index, v.label]));
    const next: TemplateVariable[] = indexes.map((i) => ({
      index: i,
      label: byIndex.get(i) ?? '',
    }));
    const same =
      next.length === form.variableContract.length &&
      next.every((v, i) => v.index === form.variableContract[i]?.index && v.label === form.variableContract[i]?.label);
    if (!same) setForm((f) => ({ ...f, variableContract: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.bodyText]);

  const validation = validateTemplateForm(form);

  async function handleSave() {
    setTouched(true);
    if (!validation.ok) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      msg91TemplateName: form.msg91TemplateName.trim(),
      category: form.category,
      languageCode: form.languageCode.trim(),
      bodyText: form.bodyText,
      variableContract: form.variableContract,
    };
    const res = initial
      ? await api.patch(`/api/admin/whatsapp-templates/${initial.id}`, payload)
      : await api.post('/api/admin/whatsapp-templates', payload);
    setSaving(false);
    if (res.success) {
      onSaved(initial ? 'Template updated.' : 'Template created.');
    } else {
      onError(res.error);
    }
  }

  const err = (k: keyof TemplateFormValues) => (touched ? validation.errors[k] : undefined);

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial ? 'Edit template' : 'New template'}
      description="Register a template body and its variable contract."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Display name" error={err('name')}>
            <input
              type="text"
              value={form.name}
              data-testid="tpl-name"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
              placeholder="e.g. Diwali greeting"
            />
          </Field>
          <Field label="MSG91 template name" error={err('msg91TemplateName')}>
            <input
              type="text"
              value={form.msg91TemplateName}
              data-testid="tpl-msg91"
              onChange={(e) => setForm({ ...form, msg91TemplateName: e.target.value })}
              className={inputCls}
              placeholder="e.g. diwali_greeting_v1"
            />
          </Field>
          <Field label="Category" error={err('category')}>
            <select
              value={form.category}
              data-testid="tpl-category"
              onChange={(e) => setForm({ ...form, category: e.target.value as TemplateCategory })}
              className={inputCls}
            >
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Language code" error={err('languageCode')}>
            <input
              type="text"
              value={form.languageCode}
              data-testid="tpl-lang"
              onChange={(e) => setForm({ ...form, languageCode: e.target.value })}
              className={inputCls}
              placeholder="en"
            />
          </Field>
        </div>

        <p className="text-[11px] text-gray-400">{categoryCostNote(form.category)}</p>

        <Field label="Message body" error={err('bodyText')}>
          <textarea
            value={form.bodyText}
            data-testid="tpl-body"
            onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
            rows={4}
            className={`${inputCls} font-sans resize-y`}
            placeholder="Hi {{1}}, your order {{2}} is confirmed."
          />
          <p className="text-[11px] text-gray-400 mt-1">
            Use {'{{1}}'}, {'{{2}}'}, … for variables. Labels appear below as you add them.
          </p>
        </Field>

        {/* Variable labels */}
        {form.variableContract.length > 0 && (
          <div className="space-y-2" data-testid="tpl-vars">
            <p className="text-xs font-semibold text-gray-700">Variable labels</p>
            {form.variableContract.map((v, i) => (
              <div key={v.index} className="flex items-center gap-2">
                <span className="font-mono text-xs text-[var(--brand-primary)] w-12 shrink-0">
                  {`{{${v.index}}}`}
                </span>
                <input
                  type="text"
                  value={v.label}
                  data-testid={`tpl-var-label-${v.index}`}
                  onChange={(e) => {
                    const next = [...form.variableContract];
                    next[i] = { ...v, label: e.target.value };
                    setForm({ ...form, variableContract: next });
                  }}
                  placeholder={`Label for variable ${v.index} (e.g. Outlet name)`}
                  className={inputCls}
                />
              </div>
            ))}
          </div>
        )}

        {touched && validation.errors.variableContract && (
          <p className="text-[11px] text-red-600 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" />
            {validation.errors.variableContract}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-xs px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            data-testid="save-template-btn"
            className="inline-flex items-center gap-1.5 text-xs px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26] disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {initial ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const inputCls =
  'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30';

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-1.5">{label}</label>
      {children}
      {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { Loader2, AlertTriangle, Check, Lock, MessageSquare } from 'lucide-react';
import {
  type WizardState,
  type WizardAction,
  type WhatsappTemplate,
  contractHint,
  categoryCostNote,
  categoryIsPaid,
} from '@/lib/whatsapp-broadcasts';

export function TemplateStep({
  state,
  dispatch,
  templates,
  loading,
  error,
  onRetry,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  templates: WhatsappTemplate[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const active = templates.filter((t) => t.status === 'ACTIVE');

  if (loading) {
    return (
      <div className="py-12 text-center text-gray-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
        Loading templates…
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-12 text-center text-sm">
        <AlertTriangle className="w-5 h-5 text-red-500 mx-auto mb-2" />
        <p className="text-red-700">{error}</p>
        <button
          onClick={onRetry}
          className="mt-3 px-4 py-1.5 text-xs font-medium border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          Retry
        </button>
      </div>
    );
  }
  if (active.length === 0) {
    return (
      <div className="py-12 text-center">
        <MessageSquare className="w-6 h-6 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-semibold text-gray-900">No active templates</p>
        <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto">
          Only approved, active templates can be broadcast. Create one in the template
          library first.
        </p>
        <Link
          href="/admin/whatsapp-broadcasts/templates"
          className="inline-flex text-xs px-4 py-2 mt-4 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-[#a50d26]"
        >
          Open template library
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Only active, MSG91-approved templates are shown. Select one to see its message
        body and variable contract.
      </p>
      <div className="space-y-3">
        {active.map((t) => {
          const selected = state.templateId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => dispatch({ type: 'SELECT_TEMPLATE', templateId: t.id })}
              data-testid={`template-${t.id}`}
              aria-pressed={selected}
              className={`w-full text-left border rounded-xl p-4 transition-colors ${
                selected
                  ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5 ring-1 ring-[var(--brand-primary)]/30'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                    {t.name}
                    {selected && <Check className="w-4 h-4 text-[var(--brand-primary)]" />}
                  </p>
                  <p className="text-[11px] font-mono text-gray-400 mt-0.5">
                    {t.msg91TemplateName} · {t.languageCode}
                  </p>
                </div>
                <span
                  className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    categoryIsPaid(t.category)
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-gray-50 text-gray-600 border-gray-200'
                  }`}
                >
                  {t.category}
                </span>
              </div>

              {/* Body with {{n}} placeholders visible */}
              <pre className="mt-3 whitespace-pre-wrap text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-lg p-3 font-sans">
                {t.bodyText}
              </pre>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <p className="text-[11px] text-gray-500">
                  Variables:{' '}
                  <span className="font-medium text-gray-700">
                    {contractHint(t.variableContract)}
                  </span>
                </p>
                <p className="text-[11px] text-gray-400">{categoryCostNote(t.category)}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Honest note: archived templates exist but can't be broadcast */}
      {templates.some((t) => t.status === 'ARCHIVED') && (
        <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
          <Lock className="w-3 h-3" />
          Archived templates are hidden — only active templates can be broadcast.
        </p>
      )}
    </div>
  );
}

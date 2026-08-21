'use client';

import { AlertTriangle } from 'lucide-react';
import {
  type WizardState,
  type WizardAction,
  type WhatsappTemplate,
  type VarMappingKind,
  fieldOptionsForScope,
  isMappingComplete,
} from '@/lib/whatsapp-broadcasts';

/**
 * Step ③ — map each template variable ({{n}}) to a value source.
 *  - FILTER mode: an outlet/rep FIELD or a CONSTANT string.
 *  - EXCEL mode:  an uploaded COLUMN header (or a CONSTANT).
 */
export function MapStep({
  state,
  dispatch,
  template,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  template: WhatsappTemplate | null;
}) {
  if (!template) {
    return (
      <div className="py-12 text-center text-sm text-gray-500">
        Pick a template first.
      </div>
    );
  }
  const contract = [...template.variableContract].sort((a, b) => a.index - b.index);
  const excelColumns = state.excel?.columns ?? [];
  const complete = isMappingComplete(contract, state.mapping);
  // Only offer FIELD options valid for the chosen audience scope — an OUTLETS blast
  // must not offer "Sales rep name" (and vice-versa), which would render blank.
  const fieldOptions = fieldOptionsForScope(state.scope);

  if (contract.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm font-semibold text-gray-900">No variables to map</p>
        <p className="text-xs text-gray-500 mt-1">
          “{template.name}” has no {'{{n}}'} placeholders — nothing to configure here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Fill each variable in{' '}
        <span className="font-semibold text-gray-700">{template.name}</span>. Every variable
        must be mapped before you can preview.
      </p>

      <div className="space-y-3">
        {contract.map((v) => {
          const m = state.mapping[v.index];
          const kind: VarMappingKind = m?.kind ?? (state.audienceMode === 'EXCEL' ? 'COLUMN' : 'FIELD');
          return (
            <div
              key={v.index}
              className="border border-gray-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-[auto,1fr,1.4fr] gap-3 items-center"
              data-testid={`map-var-${v.index}`}
            >
              <div className="text-sm">
                <span className="font-mono text-[var(--brand-primary)]">{`{{${v.index}}}`}</span>
                <div className="text-[11px] text-gray-500">{v.label}</div>
              </div>

              {/* Source kind */}
              <select
                value={kind}
                aria-label={`Source type for variable ${v.index}`}
                data-testid={`map-kind-${v.index}`}
                onChange={(e) =>
                  dispatch({
                    type: 'SET_MAPPING',
                    index: v.index,
                    mapping: { kind: e.target.value as VarMappingKind, value: '' },
                  })
                }
                className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
              >
                {state.audienceMode === 'EXCEL' ? (
                  <>
                    <option value="COLUMN">From uploaded column</option>
                    <option value="CONSTANT">Fixed text</option>
                  </>
                ) : (
                  <>
                    <option value="FIELD">From outlet / rep field</option>
                    <option value="CONSTANT">Fixed text</option>
                  </>
                )}
              </select>

              {/* Source value */}
              {kind === 'CONSTANT' ? (
                <input
                  type="text"
                  value={m?.value ?? ''}
                  placeholder="Same text for everyone"
                  aria-label={`Constant value for variable ${v.index}`}
                  data-testid={`map-value-${v.index}`}
                  onChange={(e) =>
                    dispatch({
                      type: 'SET_MAPPING',
                      index: v.index,
                      mapping: { kind: 'CONSTANT', value: e.target.value },
                    })
                  }
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                />
              ) : kind === 'COLUMN' ? (
                <select
                  value={m?.value ?? ''}
                  aria-label={`Column for variable ${v.index}`}
                  data-testid={`map-value-${v.index}`}
                  onChange={(e) =>
                    dispatch({
                      type: 'SET_MAPPING',
                      index: v.index,
                      mapping: { kind: 'COLUMN', value: e.target.value },
                    })
                  }
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                >
                  <option value="">Choose a column…</option>
                  {excelColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={m?.value ?? ''}
                  aria-label={`Field for variable ${v.index}`}
                  data-testid={`map-value-${v.index}`}
                  onChange={(e) =>
                    dispatch({
                      type: 'SET_MAPPING',
                      index: v.index,
                      mapping: { kind: 'FIELD', value: e.target.value },
                    })
                  }
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                >
                  <option value="">Choose a field…</option>
                  {fieldOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      {state.audienceMode === 'EXCEL' && excelColumns.length === 0 && (
        <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          Your uploaded file has no variable columns — map each variable to fixed text
          instead.
        </p>
      )}

      {!complete && (
        <p className="text-[11px] text-amber-700 flex items-center gap-1.5" data-testid="map-incomplete">
          <AlertTriangle className="w-3 h-3" />
          Map every variable to continue.
        </p>
      )}
    </div>
  );
}

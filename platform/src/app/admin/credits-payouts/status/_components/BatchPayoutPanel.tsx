'use client';

/**
 * Everything about one upload's money rows, mounted inside the expanded batch on the Payout Status page:
 * status breakdown (A) → row drill-down (B) with the cancel actions (C, GIFSY_ADMIN inside the client only) →
 * cancellation history (D) → per-upload "Cancel payouts — upload file" shortcut (E).
 * After a cancellation everything here reloads (refreshKey).
 */
import { useCallback, useState } from 'react';
import { useAdminSession } from '@/lib/admin-session';
import { useAssumedContext } from '@/lib/use-assumed-context';
import PayoutStatusBreakdown from './PayoutStatusBreakdown';
import PayoutEntriesTable, { type CancelRequest } from './PayoutEntriesTable';
import CancelPayoutsDialog from './CancelPayoutsDialog';
import CancellationHistory from './CancellationHistory';
import CancelPayoutsFileSection from './CancelPayoutsFileSection';
import type { PayoutStatusData } from './payout-cancel-shared';

/**
 * Cancel actions are for a GIFSY_ADMIN working inside a client (assumed tenant) only. The server re-checks it and
 * its refusal message is shown if the hint is ever wrong.
 */
export function useCanCancelPayouts(): boolean {
  const session = useAdminSession();
  const { assumed, ready } = useAssumedContext();
  return session.role === 'GIFSY_ADMIN' && ready && assumed;
}

interface Props {
  batchId: string;
  batchCode: string;
  canCancel: boolean;
  /** Something was cancelled — the page may refresh its own list. */
  onCancelled?: () => void;
}

export default function BatchPayoutPanel({ batchId, batchCode, canCancel, onCancelled }: Props) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState('');
  const [fieldId, setFieldId] = useState('');
  const [fields, setFields] = useState<Array<{ fieldId: string; fieldName: string }>>([]);
  const [cancelReq, setCancelReq] = useState<CancelRequest | null>(null);
  const [showFile, setShowFile] = useState(false);

  const onLoaded = useCallback((d: PayoutStatusData) => {
    setFields(d.fields.map((f) => ({ fieldId: f.fieldId, fieldName: f.fieldName })));
  }, []);

  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onCancelled?.();
  }, [onCancelled]);

  const fieldName = fields.find((f) => f.fieldId === fieldId)?.fieldName ?? null;

  return (
    <div data-testid={`batch-payout-panel-${batchId}`}>
      <PayoutStatusBreakdown
        batchId={batchId}
        refreshKey={refreshKey}
        onLoaded={onLoaded}
        onPick={(s, f) => { setStatus(s); setFieldId(f ?? ''); }}
      />
      <PayoutEntriesTable
        batchId={batchId}
        refreshKey={refreshKey}
        fields={fields}
        status={status}
        fieldId={fieldId}
        onStatusChange={setStatus}
        onFieldChange={setFieldId}
        canCancel={canCancel}
        onCancel={setCancelReq}
      />
      <CancellationHistory batchId={batchId} refreshKey={refreshKey} />
      {canCancel && (
        <div className="px-5 py-3 border-b border-gray-100">
          <button
            type="button"
            onClick={() => setShowFile((v) => !v)}
            aria-expanded={showFile}
            className="text-xs text-red-700 hover:underline"
          >
            {showFile ? 'Hide “Cancel payouts — upload file” for this upload' : 'Cancel payouts of this upload by file…'}
          </button>
          {showFile && (
            <div className="mt-2">
              <CancelPayoutsFileSection
                batchId={batchId}
                batchCode={batchCode}
                fieldId={fieldId || undefined}
                fieldName={fieldName}
                onApplied={refreshAll}
              />
            </div>
          )}
        </div>
      )}
      {cancelReq && (
        <CancelPayoutsDialog
          request={cancelReq}
          onClose={() => setCancelReq(null)}
          onDone={refreshAll}
        />
      )}
    </div>
  );
}

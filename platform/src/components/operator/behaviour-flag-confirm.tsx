'use client';

/**
 * Confirm-before-ON dialog for a runtime behaviour flag that carries `confirmOn` meta (e.g.
 * allowPayoutWithoutPan). Shared by the Gifsy console client page and the new-client wizard so the
 * copy and behaviour never drift. Switching a flag OFF never needs this dialog.
 */
import { Modal } from '@/components/ui/modal';
import { BEHAVIOUR_FLAG_META, type BehaviourFlagKey } from '@/lib/platform/behaviour-flags';

export function BehaviourFlagConfirm({
  flagKey,
  tenantLabel,
  busy = false,
  onCancel,
  onConfirm,
}: {
  /** The flag being switched ON (null = dialog closed). */
  flagKey: BehaviourFlagKey | null;
  /** Shown under the title, e.g. "Tenant: Bajaj Consumer Care Ltd". */
  tenantLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (key: BehaviourFlagKey) => void;
}) {
  const meta = flagKey ? BEHAVIOUR_FLAG_META[flagKey].confirmOn : undefined;
  return (
    <Modal
      open={!!flagKey && !!meta}
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={meta?.title ?? ''}
      description={tenantLabel}
    >
      <div data-testid="behaviour-flag-confirm" className="space-y-4">
        <ul className="list-disc pl-5 space-y-2 text-sm text-gray-700">
          {meta?.points.map((pt) => <li key={pt}>{pt}</li>)}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { if (flagKey) onConfirm(flagKey); }}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
          >
            {meta?.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

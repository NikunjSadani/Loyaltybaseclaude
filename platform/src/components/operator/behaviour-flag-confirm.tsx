'use client';

/**
 * Confirm dialog for a runtime behaviour flag: before switching ON a flag with `confirmOn` meta (e.g.
 * allowPayoutWithoutPan), or before switching OFF a flag with `confirmOff` meta (requireLocation — a default-ON
 * compliance control). Shared by the Gifsy console client page and the new-client wizard so the copy and behaviour
 * never drift.
 */
import { Modal } from '@/components/ui/modal';
import { BEHAVIOUR_FLAG_META, type BehaviourFlagKey } from '@/lib/platform/behaviour-flags';

export function BehaviourFlagConfirm({
  flagKey,
  next = true,
  tenantLabel,
  tenantName,
  busy = false,
  onCancel,
  onConfirm,
}: {
  /** The flag being switched (null = dialog closed). */
  flagKey: BehaviourFlagKey | null;
  /** The value being switched TO (true = ON → `confirmOn` copy; false = OFF → `confirmOff` copy). */
  next?: boolean;
  /** Shown under the title, e.g. "Tenant: Bajaj Consumer Care Ltd". */
  tenantLabel: string;
  /** Replaces `{tenant}` in a title. */
  tenantName?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (key: BehaviourFlagKey, next: boolean) => void;
}) {
  const flag = flagKey ? BEHAVIOUR_FLAG_META[flagKey] : undefined;
  const meta = flag ? (next ? flag.confirmOn : flag.confirmOff) : undefined;
  const title = (meta?.title ?? '').replace('{tenant}', tenantName || 'this client');
  return (
    <Modal
      open={!!flagKey && !!meta}
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={title}
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
            onClick={() => { if (flagKey) onConfirm(flagKey, next); }}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
          >
            {meta?.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

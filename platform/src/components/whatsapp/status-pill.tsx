'use client';

import {
  type BroadcastStatus,
  BROADCAST_STATUS_LABEL,
} from '@/lib/whatsapp-broadcasts';

const STYLES: Record<BroadcastStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600 border-gray-200',
  SCHEDULED: 'bg-amber-50 text-amber-700 border-amber-200',
  SENDING: 'bg-blue-50 text-blue-700 border-blue-200',
  SENT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-200',
};

export function StatusPill({ status }: { status: BroadcastStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STYLES[status]}`}
      data-testid={`status-${status}`}
    >
      {status === 'SENDING' && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 animate-pulse" />
      )}
      {BROADCAST_STATUS_LABEL[status]}
    </span>
  );
}

export default StatusPill;

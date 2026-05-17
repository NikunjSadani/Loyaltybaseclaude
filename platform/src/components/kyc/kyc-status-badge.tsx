import React from 'react';
import { CheckCircle, Clock, AlertTriangle, XCircle, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { KYCStatus } from '@/types';

interface KYCStatusBadgeProps {
  status: KYCStatus;
  showIcon?: boolean;
}

const config: Record<
  KYCStatus,
  {
    icon: React.ReactNode;
    label: string;
    variant: 'success' | 'warning' | 'danger' | 'info' | 'default';
  }
> = {
  [KYCStatus.APPROVED]: {
    icon: <CheckCircle className="h-3.5 w-3.5" />,
    label: 'Approved',
    variant: 'success',
  },
  [KYCStatus.PENDING]: {
    icon: <Clock className="h-3.5 w-3.5" />,
    label: 'Pending',
    variant: 'warning',
  },
  [KYCStatus.SUBMITTED]: {
    icon: <Clock className="h-3.5 w-3.5" />,
    label: 'Submitted',
    variant: 'info',
  },
  [KYCStatus.UNDER_REVIEW]: {
    icon: <Clock className="h-3.5 w-3.5" />,
    label: 'Under Review',
    variant: 'info',
  },
  [KYCStatus.REJECTED]: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: 'Rejected',
    variant: 'danger',
  },
  [KYCStatus.RESUBMISSION_REQUIRED]: {
    icon: <RotateCcw className="h-3.5 w-3.5" />,
    label: 'Re-upload Required',
    variant: 'danger',
  },
};

export function KYCStatusBadge({ status, showIcon = true }: KYCStatusBadgeProps) {
  const { icon, label, variant } = config[status];
  return (
    <Badge variant={variant}>
      {showIcon && icon}
      {label}
    </Badge>
  );
}

export default KYCStatusBadge;

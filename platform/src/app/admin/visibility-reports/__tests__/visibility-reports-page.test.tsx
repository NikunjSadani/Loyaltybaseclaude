/// <reference types="vitest/globals" />
/**
 * Tenant Visibility Reports page: the backend report/tenant routes are CLIENT_ADMIN-only, so any other role that reaches
 * the page directly gets a plain message (never a generic 403); a client admin gets the report view.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const role = { current: 'CLIENT_ADMIN' as string };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: role.current }) }));
vi.mock('@/lib/gifsy-settings', () => ({ useGifsySettings: () => ({ visibilityCaptureMode: 'PHOTO_APPROVAL' }) }));
vi.mock('@/components/admin/VisibilityReportView', () => ({
  VisibilityReportView: ({ variant }: { variant: string }) => <div data-testid="report-view">{variant}</div>,
}));

import VisibilityReportsPage from '../page';

describe('Visibility Reports page — role', () => {
  beforeEach(() => { role.current = 'CLIENT_ADMIN'; });

  it('CLIENT_ADMIN sees the tenant report', () => {
    render(<VisibilityReportsPage />);
    expect(screen.getByTestId('report-view')).toHaveTextContent('tenant');
  });

  it('MIS_USER reaching the page directly gets a plain message, not a 403', () => {
    role.current = 'MIS_USER';
    render(<VisibilityReportsPage />);
    expect(screen.getByText('Visibility reports are available to client admins.')).toBeInTheDocument();
    expect(screen.queryByTestId('report-view')).not.toBeInTheDocument();
  });
});

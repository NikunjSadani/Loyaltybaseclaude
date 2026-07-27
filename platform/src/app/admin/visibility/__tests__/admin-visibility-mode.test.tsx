/// <reference types="vitest/globals" />
/**
 * AVM — Admin Visibility page mode branch (VISIBILITY-POSM-DESIGN.md D3 / M2).
 *
 * AVM1: visibilityEnabled=false → the whole surface is the "disabled" note.
 * AVM2: PHOTO_APPROVAL → the config/form/captures/report tab surface (NOT the upload panel).
 * AVM3: AMOUNT_UPLOAD → the Excel bulk-upload panel (NOT the photo tabs).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';

let mockSettings: { visibilityEnabled?: boolean; visibilityCaptureMode?: string } = {
  visibilityEnabled: true,
  visibilityCaptureMode: 'PHOTO_APPROVAL',
};
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => mockSettings,
}));

// Stub the heavy child components so the test isolates the page's mode branch.
vi.mock('@/components/admin/VisibilityConfigEditor', () => ({
  VisibilityConfigEditor: () => <div data-testid="stub-config" />,
}));
vi.mock('@/components/admin/VisibilityFormBuilder', () => ({
  VisibilityFormBuilder: () => <div data-testid="stub-form" />,
}));
vi.mock('@/components/admin/VisibilityCaptureQueue', () => ({
  VisibilityCaptureQueue: () => <div data-testid="stub-captures" />,
}));
vi.mock('@/components/admin/VisibilityReportView', () => ({
  VisibilityReportView: () => <div data-testid="stub-report" />,
}));
vi.mock('@/components/admin/VisibilityAmountUploadPanel', () => ({
  VisibilityAmountUploadPanel: () => <div data-testid="stub-amount-upload" />,
}));

import VisibilityAdminPage from '../page';

describe('AVM — Admin Visibility page mode branch', () => {
  it('AVM1: visibility disabled → the disabled note, no panels', () => {
    mockSettings = { visibilityEnabled: false, visibilityCaptureMode: 'PHOTO_APPROVAL' };
    render(<VisibilityAdminPage />);
    expect(screen.getByText(/visibility is disabled for this tenant/i)).toBeInTheDocument();
    expect(screen.queryByTestId('stub-config')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-amount-upload')).not.toBeInTheDocument();
  });

  it('AVM2: PHOTO_APPROVAL → the photo tabs (config first), NOT the upload panel', () => {
    mockSettings = { visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' };
    render(<VisibilityAdminPage />);
    expect(screen.getByTestId('stub-config')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /captures/i })).toBeInTheDocument();
    expect(screen.queryByTestId('stub-amount-upload')).not.toBeInTheDocument();
  });

  it('AVM3: AMOUNT_UPLOAD → the Excel bulk-upload panel, NOT the photo tabs', () => {
    mockSettings = { visibilityEnabled: true, visibilityCaptureMode: 'AMOUNT_UPLOAD' };
    render(<VisibilityAdminPage />);
    expect(screen.getByTestId('stub-amount-upload')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-config')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /captures/i })).not.toBeInTheDocument();
  });
});

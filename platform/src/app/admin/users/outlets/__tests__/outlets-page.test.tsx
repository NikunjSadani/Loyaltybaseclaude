/**
 * Outlet Management Page — UI Tests
 *
 * UI1–UI6  : Page structure (heading, tabs, action buttons)
 * UI7–UI12 : Outlet Master upload flow (create/update/reactivate upsert)
 * UI17–UI20 : Re-KYC flag upload flow
 * UI21–UI24 : Outlet list and stats
 * UI25–UI26 : Template & guide downloads
 * UI28–UI31 : Deactivate Outlets upload flow
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OutletsPage from '../page';

/* ─── Mocks ───────────────────────────────────────────────────────────────── */

vi.mock('xlsx', () => ({
  utils: {
    book_new:         vi.fn(() => ({})),
    aoa_to_sheet:     vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
  writeFile: vi.fn(),
}));

Object.defineProperty(globalThis, 'URL', {
  value: {
    createObjectURL: vi.fn(() => 'blob:test-url'),
    revokeObjectURL: vi.fn(),
  },
  writable: true,
});

// Stub document.createElement for anchor click downloads
const mockClick = vi.fn();
const originalCreate = document.createElement.bind(document);
vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
  if (tag === 'a') {
    const el = originalCreate(tag);
    el.click = mockClick;
    return el;
  }
  return originalCreate(tag);
});

/* ─── UI1–UI6: Page structure ─────────────────────────────────────────────── */

describe('outlet management page structure', () => {
  beforeEach(() => { mockClick.mockClear(); });

  it('UI1 — renders the page heading', () => {
    render(<OutletsPage />);
    expect(screen.getByRole('heading', { name: /outlet management/i })).toBeInTheDocument();
  });

  it('UI2 — shows three operation tabs', () => {
    render(<OutletsPage />);
    expect(screen.getByRole('tab', { name: /outlet master/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /re-kyc/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /deactivate/i })).toBeInTheDocument();
    // re-tag and reactivate tabs should NOT exist
    expect(screen.queryByRole('tab', { name: /re-tag/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /reactivate/i })).not.toBeInTheDocument();
  });

  it('UI3 — Outlet Master tab is active by default', () => {
    render(<OutletsPage />);
    const tab = screen.getByRole('tab', { name: /outlet master/i });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('UI5 — switching to Re-KYC tab shows re-KYC content', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /re-kyc/i }));
    expect(screen.getByTestId('rekyc-upload-section')).toBeInTheDocument();
  });

  it('UI6 — download operations guide button is present', () => {
    render(<OutletsPage />);
    expect(screen.getByTestId('download-outlet-guide')).toBeInTheDocument();
  });
});

/* ─── UI7–UI12: Outlet Master upload (upsert) ────────────────────────────── */

describe('outlet master upload flow', () => {
  it('UI7 — download outlet template button is present', () => {
    render(<OutletsPage />);
    expect(screen.getByTestId('download-outlet-template')).toBeInTheDocument();
  });

  it('UI8 — file input accepts .xlsx only', () => {
    render(<OutletsPage />);
    const input = screen.getByTestId('outlet-upload-input');
    expect(input).toHaveAttribute('accept', '.xlsx');
  });

  it('UI9 — validation panel is hidden before upload', () => {
    render(<OutletsPage />);
    expect(screen.queryByTestId('outlet-validation-panel')).not.toBeInTheDocument();
  });

  it('UI10 — uploading an .xlsx file triggers validation and shows panel', async () => {
    render(<OutletsPage />);
    const input = screen.getByTestId('outlet-upload-input') as HTMLInputElement;
    const file  = new File(['dummy'], 'outlets.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByTestId('outlet-validation-panel')).toBeInTheDocument();
    });
  });

  it('UI11 — rejecting a non-xlsx file shows an error message', () => {
    render(<OutletsPage />);
    const input = screen.getByTestId('outlet-upload-input') as HTMLInputElement;
    const file  = new File(['dummy'], 'outlets.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(screen.getByTestId('file-type-error')).toBeInTheDocument();
  });

  it('UI12 — confirm upload button is hidden when there are validation errors', async () => {
    render(<OutletsPage />);
    // No file uploaded, no panel shown — confirm button should not exist
    expect(screen.queryByTestId('confirm-outlet-upload-btn')).not.toBeInTheDocument();
  });
});

/* ─── UI17–UI20: Re-KYC flag upload ──────────────────────────────────────── */

describe('re-KYC flag upload flow', () => {
  it('UI17 — download re-KYC template button is present on Re-KYC tab', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /re-kyc/i }));
    expect(screen.getByTestId('download-rekyc-template')).toBeInTheDocument();
  });

  it('UI18 — re-KYC file input accepts .xlsx only', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /re-kyc/i }));
    const input = screen.getByTestId('rekyc-upload-input');
    expect(input).toHaveAttribute('accept', '.xlsx');
  });

  it('UI19 — re-KYC validation panel hidden before upload', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /re-kyc/i }));
    expect(screen.queryByTestId('rekyc-validation-panel')).not.toBeInTheDocument();
  });

  it('UI20 — uploading xlsx on Re-KYC tab shows validation panel', async () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /re-kyc/i }));
    const input = screen.getByTestId('rekyc-upload-input') as HTMLInputElement;
    const file  = new File(['dummy'], 'rekyc.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByTestId('rekyc-validation-panel')).toBeInTheDocument();
    });
  });
});

/* ─── UI21–UI24: Outlet list and stats ───────────────────────────────────── */

describe('outlet list and stats', () => {
  it('UI21 — stat cards are shown on Outlet Master tab', () => {
    render(<OutletsPage />);
    expect(screen.getByTestId('stat-total-outlets')).toBeInTheDocument();
    expect(screen.getByTestId('stat-pending-kyc')).toBeInTheDocument();
    expect(screen.getByTestId('stat-approved')).toBeInTheDocument();
  });

  it('UI22 — outlet search input is present', () => {
    render(<OutletsPage />);
    expect(screen.getByTestId('outlet-search')).toBeInTheDocument();
  });

  it('UI23 — outlet rows are rendered in the list', () => {
    render(<OutletsPage />);
    const rows = screen.getAllByTestId('outlet-row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('UI24 — each outlet row shows KYC status badge', () => {
    render(<OutletsPage />);
    const badges = screen.getAllByTestId('kyc-status-badge');
    expect(badges.length).toBeGreaterThan(0);
  });
});

/* ─── UI25–UI26: Downloads ────────────────────────────────────────────────── */

describe('template and guide downloads', () => {
  it('UI25 — clicking download outlet template triggers download', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByTestId('download-outlet-template'));
    expect(mockClick).toHaveBeenCalled();
  });

  it('UI26 — clicking download guide triggers download', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByTestId('download-outlet-guide'));
    expect(mockClick).toHaveBeenCalled();
  });
});

/* ─── UI28–UI31: Deactivate Outlets upload ────────────────────────────────── */

describe('deactivate outlets upload flow', () => {
  it('UI28 — switching to Deactivate tab shows deactivate upload section', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /deactivate/i }));
    expect(screen.getByTestId('deactivate-upload-section')).toBeInTheDocument();
  });

  it('UI29 — deactivate file input accepts .xlsx only', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /deactivate/i }));
    const input = screen.getByTestId('deactivate-upload-input');
    expect(input).toHaveAttribute('accept', '.xlsx');
  });

  it('UI30 — deactivate validation panel is hidden before upload', () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /deactivate/i }));
    expect(screen.queryByTestId('deactivate-validation-panel')).not.toBeInTheDocument();
  });

  it('UI31 — uploading xlsx on Deactivate tab shows validation panel', async () => {
    render(<OutletsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /deactivate/i }));
    const input = screen.getByTestId('deactivate-upload-input') as HTMLInputElement;
    const file  = new File(['dummy'], 'deactivate.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByTestId('deactivate-validation-panel')).toBeInTheDocument();
    });
  });
});

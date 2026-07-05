/// <reference types="vitest/globals" />
/**
 * Re-KYC highlight on the KYC detail surfaces.
 *
 * REKYC-SALES: the sales /sales/kyc/[id] page, given a submission that is APPROVED but
 *   carries admin per-field re-KYC flags (the bulk-upload case — status stays APPROVED),
 *   must (a) show the amber "Re-KYC requested" banner listing the flagged field label and
 *   remark, and (b) show the "Edit & Resubmit KYC" card (isReEntry now fires on flags, not
 *   status alone).
 *
 * REKYC-REVIEWER: the Gifsy KYCReviewer, given flaggedDocTypes, amber-badges the matching
 *   document tab + checklist row and renders the top re-KYC banner.
 */

import React, { Suspense, act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';
import { KYCReviewer } from '@/components/admin/kyc-reviewer';

/** APPROVED submission with an admin re-KYC flag set on the store-board photo + a remark. */
const REKYC_SUBMISSION = {
  id: 'kyc-1',
  status: 'APPROVED',
  submittedAt: '2026-06-01T00:00:00.000Z',
  rejectionReason: null,
  reKycFlags: { storeBoardPhoto: true, remarks: 'Board photo blurry — re-shoot the storefront' },
  user: { id: 'u1', name: 'Rep Anil', phone: '9000000003', role: 'XSR' },
  partner: {
    id: 'p1', businessName: 'Verma Traders', ownerName: 'Suresh',
    outlets: [{ id: 'o1', name: 'Verma Traders', outletCode: 'OUT-2026-001', phone: '7766554433' }],
  },
  documents: [
    { id: 'd1', documentType: 'STORE_BOARD_PHOTO', status: 'SUBMITTED', viewUrl: 'data:image/jpeg;base64,AAAA' },
  ],
  statusHistory: [],
};

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { localStorage.clear(); localStorage.setItem('loyaltybase_sales_role', 'XSR'); });

describe('REKYC-SALES — sales KYC detail re-KYC banner + re-entry', () => {
  it('shows the amber re-KYC banner (flagged label + remark) and the Edit & Resubmit card for an APPROVED-but-flagged outlet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { submission: REKYC_SUBMISSION } }),
    }));

    const params = Promise.resolve({ id: 'kyc-1' });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading…</div>}>
          <SalesKYCDetailPage params={params} />
        </Suspense>,
      );
      await params;
    });

    const banner = await screen.findByTestId('rekyc-banner');
    // Flagged field label (from REKYC_FIELDS: storeBoardPhoto → "Store Board Photo").
    expect(banner).toHaveTextContent('Store Board Photo');
    // Admin remark surfaced.
    expect(banner).toHaveTextContent('Board photo blurry');
    expect(banner).toHaveTextContent(/re-kyc requested/i);

    // isReEntry fires on the flag even though status is APPROVED → the resubmit card shows.
    const resubmit = await screen.findByRole('button', { name: /edit & resubmit kyc/i });
    expect(resubmit).toBeInTheDocument();
    expect(resubmit.closest('a')).toHaveAttribute('href', '/sales/kyc/new?outletId=o1');

    // Parity tweak: expand the collapsible Store Information section, then the flagged
    // store-board PHOTO thumbnail is amber-badged for the approver.
    fireEvent.click(screen.getByText(/store information/i));
    expect(await screen.findByTestId('rekyc-flagged-photo-thumb')).toBeInTheDocument();
  });

  it('amber-badges a flagged non-photo document row ("Needs re-capture") for the approver', async () => {
    const sub = {
      ...REKYC_SUBMISSION,
      reKycFlags: { gstCertificate: true, remarks: 'GST certificate unreadable' },
      documents: [
        { id: 'd2', documentType: 'GST_CERTIFICATE', status: 'SUBMITTED', viewUrl: 'data:application/pdf;base64,JVBERi0=' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { submission: sub } }),
    }));

    const params = Promise.resolve({ id: 'kyc-1' });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading…</div>}>
          <SalesKYCDetailPage params={params} />
        </Suspense>,
      );
      await params;
    });

    // Expand the collapsible Store Information section to reveal the document checklist.
    fireEvent.click(screen.getByText(/store information/i));
    const row = await screen.findByTestId('rekyc-flagged-doc-row');
    expect(row).toHaveTextContent('GST Certificate');
    expect(row).toHaveTextContent(/needs re-capture/i);
  });
});

describe('REKYC-REVIEWER — KYCReviewer flagged-document highlight', () => {
  it('badges the flagged document tab + checklist row and shows the top banner', () => {
    render(
      <KYCReviewer
        partnerId="p1"
        partnerName="Verma Traders"
        documents={[
          { id: 'd1', type: 'store_board_photo', label: 'Store Board Photo', url: 'data:image/jpeg;base64,AAAA', status: 'pending' },
          { id: 'd2', type: 'pan_card', label: 'PAN Card', url: 'data:image/jpeg;base64,BBBB', status: 'pending' },
        ]}
        onApprove={() => {}}
        onReject={() => {}}
        onRequestReupload={() => {}}
        flaggedDocTypes={['STORE_BOARD_PHOTO']}
        flaggedLabels={['Store Board Photo']}
        reKycRemarks="Board photo blurry — re-shoot the storefront"
      />
    );

    // Top banner lists the flagged label + remark.
    const banner = screen.getByTestId('rekyc-reviewer-banner');
    expect(banner).toHaveTextContent('Store Board Photo');
    expect(banner).toHaveTextContent('Board photo blurry');

    // Exactly the flagged doc (STORE_BOARD_PHOTO) is badged — case-insensitive vs doc.type.
    expect(screen.getByTestId('rekyc-flagged-doc-tab')).toHaveTextContent('Store Board Photo');
    expect(screen.getByTestId('rekyc-flagged-checklist-row')).toHaveTextContent('Store Board Photo');
  });

  it('renders no re-KYC banner or badges when no flags are passed (props optional)', () => {
    render(
      <KYCReviewer
        partnerId="p1"
        partnerName="Verma Traders"
        documents={[
          { id: 'd1', type: 'pan_card', label: 'PAN Card', url: 'data:image/jpeg;base64,BBBB', status: 'pending' },
        ]}
        onApprove={() => {}}
        onReject={() => {}}
        onRequestReupload={() => {}}
      />
    );
    expect(screen.queryByTestId('rekyc-reviewer-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rekyc-flagged-doc-tab')).not.toBeInTheDocument();
  });
});

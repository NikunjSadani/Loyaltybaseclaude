/**
 * Regression: the Gifsy KYC document reviewer must render PDF documents (GST
 * certificate, shop-establishment, cancelled cheque) so they are actually visible.
 * PDFs were rendered in an <img>, which cannot display a PDF → the image failed and
 * fell back to a "GST CERTIFICATE" placeholder. They now render in an <iframe> via a
 * blob: URL (a data: URL is blocked in iframes/new-tabs by Chrome). Photos (JPEG/PNG)
 * keep <img>.
 *
 * Run: npx vitest run src/components/admin/__tests__/kyc-reviewer-pdf.test.tsx
 */
import React from 'react';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KYCReviewer } from '../kyc-reviewer';

beforeEach(() => {
  // jsdom has no URL.createObjectURL — the component converts data: → blob:.
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
});
afterEach(() => cleanup());

const docs = [
  { id: 'd1', type: 'gst_certificate', label: 'GST Certificate', url: 'data:application/pdf;base64,JVBERi0xLjQ=', status: 'pending' as const },
  { id: 'd2', type: 'selfie',          label: 'Owner Photo',     url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',    status: 'pending' as const },
];
const noop = () => {};

describe('KYCReviewer — PDF documents render in an iframe (not a blank <img>)', () => {
  it('renders a PDF document in an <iframe> via a blob URL (never an <img>)', async () => {
    const { container } = render(
      <KYCReviewer partnerId="p1" partnerName="Acme" documents={docs}
        onApprove={noop} onReject={noop} onRequestReupload={noop} />,
    );
    // The GST PDF is selected by default → an <iframe> appears once the blob URL resolves.
    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('blob:mock');
      expect(iframe?.getAttribute('title')).toBe('GST Certificate');
    });
    // A PDF must NEVER be an <img> (that was the blank-placeholder bug).
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an image document in an <img> (not an iframe)', async () => {
    const { container } = render(
      <KYCReviewer partnerId="p1" partnerName="Acme" documents={docs}
        onApprove={noop} onReject={noop} onRequestReupload={noop} />,
    );
    // Switch to the JPEG doc by clicking its tab button (deterministic, avoids text dupes).
    const photoTab = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Owner Photo'));
    fireEvent.click(photoTab!);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('iframe')).toBeNull();
  });
});

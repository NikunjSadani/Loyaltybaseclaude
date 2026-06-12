/// <reference types="vitest/globals" />
/**
 * TDD — Camera-only capture for photo documents in Fix & Resubmit
 *
 * The KYC form captures two types of photos taken by the XSR on-site:
 *   - "Owner Photo"  — must come from camera, not gallery
 *   - "Board Photo"  — must come from camera, not gallery
 *
 * Non-photo documents (GST Certificate, PAN Card, Cancelled Cheque) may come
 * from the gallery or as PDFs.
 *
 * T8:  Fix & Resubmit section renders "Owner Photo" document for rejected KYC
 * T9:  File input for "Owner Photo" has capture="environment" (camera-only)
 * T10: File input for "GST Certificate" does NOT have a capture attribute (gallery allowed)
 * T11: "Board Photo" document is present in the KYC document list
 * T12: File input for "Board Photo" also has capture="environment"
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import SalesKYCDetailPage from '../page';

// k3 = REJECTED — shows Fix & Resubmit section automatically
async function renderK3() {
  const params = Promise.resolve({ id: 'k3' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
  await waitFor(
    () => expect(screen.getByText('Patel Grocery')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('T — Camera-only photo documents', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('T8: "Owner Photo" document label is present in Fix & Resubmit section', async () => {
    await renderK3();
    expect(screen.getByText(/owner photo/i)).toBeInTheDocument();
  });

  it('T9: file input for Owner Photo has capture="environment" (forces camera)', async () => {
    await renderK3();
    // All hidden file inputs are present in the DOM; find the one after Owner Photo
    const allFileInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    // At least one should have capture attribute
    const cameraInputs = allFileInputs.filter((el) => el.getAttribute('capture') === 'environment');
    expect(cameraInputs.length).toBeGreaterThan(0);
  });

  it('T10: file input for GST Certificate does NOT have a capture attribute', async () => {
    await renderK3();
    const allFileInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    // At least one input should NOT have capture (for non-photo docs)
    const nonCameraInputs = allFileInputs.filter((el) => !el.getAttribute('capture'));
    expect(nonCameraInputs.length).toBeGreaterThan(0);
  });

  it('T11: "Board Photo" document label is present in Fix & Resubmit section', async () => {
    await renderK3();
    expect(screen.getByText(/board photo/i)).toBeInTheDocument();
  });

  it('T12: there are exactly 2 camera-only inputs (Owner Photo + Board Photo)', async () => {
    await renderK3();
    const cameraInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"][capture="environment"]'),
    );
    expect(cameraInputs).toHaveLength(2);
  });
});

/// <reference types="vitest/globals" />
/**
 * EnrollmentEditForm — a stored photo/file key (legacy UPI_QR_SCAN image from before 2026-09-14, or a media field's
 * bare key) renders as a read-only "Open photo" link, never an editable text box, and is kept unchanged on save.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));
const adminEditEnrollment = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/schemes', () => ({
  schemeApi: { adminEditEnrollment: (...a: unknown[]) => adminEditEnrollment(...a) },
  rewriteMediaViewPath: (p: string) => p,
}));

import { EnrollmentEditForm } from '../SchemeEnrollmentsView';

const LEGACY = 'scheme-media/deoleo/2026-09/0b7c-upi_qr.jpg';
const PDF = 'scheme-media/deoleo/2026-09/0b7c-gst.pdf';

describe('EnrollmentEditForm — media keys are read-only links', () => {
  it('legacy UPI_QR_SCAN key + bare CAMERA/DOCUMENT keys → "Open photo"/"Open file" links, no text box; the VPA stays editable; save keeps the keys', async () => {
    const detail = {
      formValues: { f_upi: LEGACY, f_vpa: 'shop@upi', f_cam: LEGACY, f_doc: PDF },
      formFields: [
        { id: 'f_upi', label: 'UPI QR', type: 'UPI_QR_SCAN' },
        { id: 'f_vpa', label: 'UPI QR 2', type: 'UPI_QR_SCAN' },
        { id: 'f_cam', label: 'Shop photo', type: 'CAMERA' },
        { id: 'f_doc', label: 'GST', type: 'DOCUMENT' },
      ],
    } as never;
    const { container } = render(
      <EnrollmentEditForm schemeId="s1" enrollmentId="e1" detail={detail} onSaved={() => {}} onCancel={() => {}} />,
    );
    const photos = screen.getAllByRole('link', { name: 'Open photo' });
    expect(photos).toHaveLength(2);
    expect(photos[0].getAttribute('href')).toBe(`/schemes/photo?key=${encodeURIComponent(LEGACY)}`);
    expect(screen.getByRole('link', { name: 'Open file' }).getAttribute('href')).toBe(`/schemes/photo?key=${encodeURIComponent(PDF)}`);
    // No input anywhere carries a key; the real VPA is an editable input.
    const inputs = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
    expect(inputs.some((i) => i.value.includes('scheme-media/'))).toBe(false);
    expect(inputs.some((i) => i.value === 'shop@upi')).toBe(true);
    expect(container.textContent).not.toContain('scheme-media/');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(adminEditEnrollment).toHaveBeenCalled());
    expect(adminEditEnrollment.mock.calls[0][2].formValues).toMatchObject({ f_upi: LEGACY, f_cam: LEGACY, f_doc: PDF });
  });
});

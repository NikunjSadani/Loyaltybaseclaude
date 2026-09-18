/**
 * WhatsappConfirmCard — the "Send a test" panel.
 *
 * A GIFSY admin can fire the scheme's SAVED WhatsApp-confirm template to a number they
 * type, with an editable sample value per configured variable, WITHOUT enrolling. These
 * assert the load-bearing contract:
 *   • one editable sample input per variable, rendered IN ORDER (body_1, body_2, …);
 *   • "Send test message" POSTs { phone, bodyValues } with values in that same order;
 *   • an { ok:false, message } response surfaces MSG91's rejection reason.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const sendWhatsappTest = vi.fn();
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    sendWhatsappTest: (...a: unknown[]) => sendWhatsappTest(...a),
  },
}));

import { WhatsappConfirmCard } from '../WhatsappConfirmCard';
import type { FormField, WhatsappConfirmConfig } from '@/lib/scheme-types';

const FIELDS: FormField[] = [
  { id: 'f1', type: 'TEXT', label: 'Store name', required: false, order: 1 },
];

const CONFIG: WhatsappConfirmConfig = {
  enabled: true,
  templateName: 'scheme_enroll_confirm',
  recipient: { source: 'PARTNER_PHONE' },
  variables: [
    { token: 'OWNER_NAME' },
    { token: 'FORM_FIELD', formFieldId: 'f1' },
  ],
};

beforeEach(() => {
  sendWhatsappTest.mockResolvedValue({ success: true, data: { ok: false, message: 'template not approved in MSG91' } });
});
afterEach(() => { vi.clearAllMocks(); });

// NB: no default param — passing `renderCard(undefined)` must stay undefined (a JS default
// would re-apply 's1' and mask the unsaved-scheme case). The "saved" cases pass 's1' explicitly.
function renderCard(schemeId?: string, unsavedChanges = false) {
  return render(
    <WhatsappConfirmCard
      value={CONFIG}
      formFields={FIELDS}
      schemeId={schemeId}
      unsavedChanges={unsavedChanges}
      onChange={() => {}}
    />,
  );
}

describe('WhatsappConfirmCard — Send a test panel', () => {
  it('renders one editable sample input per variable, pre-filled and in order', () => {
    renderCard('s1');
    const v1 = screen.getByLabelText(/body_1/);
    const v2 = screen.getByLabelText(/body_2/);
    expect(v1).toHaveValue('Ramesh Kumar');           // OWNER_NAME sample
    expect(v2).toHaveValue('Sample value');            // FORM_FIELD sample
    // The FORM_FIELD row labels its bound field.
    expect(screen.getByLabelText(/body_2 · FORM_FIELD \(Store name\)/)).toBe(v2);
    // Ordered: body_1 precedes body_2 in the DOM.
    expect(v1.compareDocumentPosition(v2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('POSTs { phone, bodyValues } in variable order and surfaces an { ok:false } message', async () => {
    renderCard('s1');

    fireEvent.change(screen.getByLabelText(/test number/i), { target: { value: '9876543210' } });
    // Edit one sample to prove the (edited) value is what gets sent.
    fireEvent.change(screen.getByLabelText(/body_2/), { target: { value: 'Edited value' } });

    const btn = screen.getByRole('button', { name: /send test message/i });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() =>
      expect(sendWhatsappTest).toHaveBeenCalledWith('s1', {
        phone: '9876543210',
        bodyValues: ['Ramesh Kumar', 'Edited value'],
      }),
    );

    expect(await screen.findByText(/template not approved in MSG91/i)).toBeInTheDocument();
  });

  it('disables Send until a valid 10-digit number is entered', () => {
    renderCard('s1');
    const btn = screen.getByRole('button', { name: /send test message/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/test number/i), { target: { value: '12345' } });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/enter a 10-digit mobile number/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/test number/i), { target: { value: '9876543210' } });
    expect(btn).toBeEnabled();
  });

  it('with no saved scheme id: shows the "save first" note and keeps Send disabled', () => {
    renderCard(undefined);
    expect(screen.getByText(/save the scheme first to send a test/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/test number/i), { target: { value: '9876543210' } });
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('saved scheme WITH unsaved edits: disables Send (would test the OLD saved config) + warns to save', () => {
    renderCard('s1', /* unsavedChanges */ true);
    // Even a valid number must not enable Send while the draft differs from the saved config.
    fireEvent.change(screen.getByLabelText(/test number/i), { target: { value: '9876543210' } });
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
    expect(screen.getByText(/save your whatsapp changes first/i)).toBeInTheDocument();
  });
});

/// <reference types="vitest/globals" />
/**
 * TDD — SchemeFormBuilder Live preview (Mock ⇄ Live toggle).
 *
 * Verifies the Live toggle swaps the static mock for the REAL SchemeFormRenderer fed the
 * current in-editor schema (a real, label-associated field input with its required star
 * appears). The error-boundary guard is covered in scheme-form-builder-preview-boundary.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// The builder loads prefill sources on mount; the renderer (used by the live preview)
// imports the same module. previewMode makes no enroll/upload/OTP calls — stub them all.
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    getPrefillSources: vi.fn().mockResolvedValue({ success: false }),
    enroll: vi.fn(),
    uploadMedia: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
  },
}));

import { SchemeFormBuilder } from '../SchemeFormBuilder';
import type { EnrollmentFormSchema, FormField } from '@/lib/scheme-types';

const field = (o: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({
  label: `Field ${o.id}`,
  required: false,
  order: 0,
  ...o,
});

const schema = (fields: FormField[]): EnrollmentFormSchema => ({
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields,
});

function renderBuilder(value: EnrollmentFormSchema) {
  return render(
    <SchemeFormBuilder
      value={value}
      campaignType="LOYALTY_ONLY"
      onChange={vi.fn()}
      onCampaignTypeChange={vi.fn()}
      schemeId="preview-scheme"
      showPrefill={false}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('SchemeFormBuilder — Live preview', () => {
  it('swaps the static mock for the real renderer when Live is toggled on', async () => {
    renderBuilder(schema([field({ id: 'owner', type: 'TEXT', label: 'Owner name', required: true })]));

    // Static mock: no real, label-associated field input yet.
    expect(screen.queryByLabelText(/Owner name/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /test form \(live\)/i }));

    // Live: the REAL renderer draws a genuine <input> with its <label htmlFor> (and the
    // real required star), so the field is now reachable by its accessible name.
    const realInput = await screen.findByLabelText(/Owner name/i);
    expect(realInput.tagName).toBe('INPUT');
    // Caption makes the dry-run explicit.
    expect(screen.getByText(/nothing is saved/i)).toBeInTheDocument();
  });
});

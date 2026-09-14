/// <reference types="vitest/globals" />
/**
 * TDD — SchemeFormBuilder live-preview ERROR BOUNDARY.
 *
 * The real SchemeFormRenderer can throw while a schema is half-built. This verifies the
 * builder wraps the live preview in an error boundary: a throwing live renderer shows the
 * friendly "Finish the fields…" hint instead of crashing the builder page (the rest of the
 * builder — Add field, campaign type — stays interactive). We force the throw by mocking the
 * renderer to throw on render, which is exactly what a malformed in-progress schema does.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    getPrefillSources: vi.fn().mockResolvedValue({ success: false }),
    enroll: vi.fn(),
    uploadMedia: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
  },
}));

// Stand in for the real renderer with one that throws on render — the boundary must catch it.
vi.mock('@/components/schemes/SchemeFormRenderer', () => ({
  SchemeFormRenderer: () => {
    throw new Error('malformed schema — renderer blew up');
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

beforeEach(() => {
  vi.clearAllMocks();
  // The boundary logs the caught error; silence it so the run output stays clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SchemeFormBuilder — live-preview error boundary', () => {
  it('shows the friendly hint (not a crash) when the live renderer throws', () => {
    render(
      <SchemeFormBuilder
        value={schema([field({ id: 'owner', type: 'TEXT', label: 'Owner name' })])}
        campaignType="LOYALTY_ONLY"
        onChange={vi.fn()}
        onCampaignTypeChange={vi.fn()}
        schemeId="preview-scheme"
        showPrefill={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /test form \(live\)/i }));

    // Fallback shown, and the builder itself survived (Add field still clickable).
    expect(screen.getByText(/finish the fields to preview the live form/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add field/i })).toBeInTheDocument();
  });
});

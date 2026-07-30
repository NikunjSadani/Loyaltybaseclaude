/// <reference types="vitest/globals" />
/**
 * TDD — SchemeFormRenderer (shared enrollment renderer).
 *
 * Covers the tricky bits called out in the build spec:
 *   - conditional-required (D12b) gates submit
 *   - LOOKUP renders the mapped display value (D12a)
 *   - PHONE_OTP is prefill-locked to the owner for an approved outlet (D16)
 *   - a media field (CAMERA/DOCUMENT) uploads → stores the returned key as the value
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const uploadMedia = vi.fn();
const sendOtp = vi.fn();
const verifyOtp = vi.fn();
const enroll = vi.fn();

vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    uploadMedia: (...a: unknown[]) => uploadMedia(...a),
    sendOtp: (...a: unknown[]) => sendOtp(...a),
    verifyOtp: (...a: unknown[]) => verifyOtp(...a),
    enroll: (...a: unknown[]) => enroll(...a),
  },
}));

import { SchemeFormRenderer, type SchemeFormContext } from '../SchemeFormRenderer';
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

const baseCtx: SchemeFormContext = { schemeId: 's1', mode: 'SELF', outletApproved: false };

function mockGeolocation(fix: { lat: number; lng: number; accuracy?: number }) {
  const getCurrentPosition = vi.fn((success: PositionCallback) =>
    success({
      coords: {
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy ?? 10,
        altitude: null, altitudeAccuracy: null, heading: null, speed: null,
      },
      timestamp: Date.now(),
    } as unknown as GeolocationPosition),
  );
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { getCurrentPosition },
    configurable: true,
  });
}

beforeEach(() => {
  uploadMedia.mockReset();
  sendOtp.mockReset();
  verifyOtp.mockReset();
  enroll.mockReset();
  enroll.mockResolvedValue({ success: true, data: { enrollment: {}, submission: {} } });
  uploadMedia.mockResolvedValue({ success: true, data: { key: 'scheme-media/c/photo.jpg' } });
});

describe('conditional-required (D12b)', () => {
  it('blocks submit while the requiredWhen clause holds and the field is empty', async () => {
    const onSubmitted = vi.fn();
    render(
      <SchemeFormRenderer
        schema={schema([
          field({ id: 'kind', type: 'DROPDOWN', options: ['A', 'OTHER'] }),
          field({ id: 'other', type: 'TEXT', requiredWhen: { fieldId: 'kind', op: 'eq', value: 'OTHER' } }),
        ])}
        context={baseCtx}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Field kind/i), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(enroll).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('submits once the conditionally-required field is filled', async () => {
    const onSubmitted = vi.fn();
    render(
      <SchemeFormRenderer
        schema={schema([
          field({ id: 'kind', type: 'DROPDOWN', options: ['A', 'OTHER'] }),
          field({ id: 'other', type: 'TEXT', requiredWhen: { fieldId: 'kind', op: 'eq', value: 'OTHER' } }),
        ])}
        context={baseCtx}
        onSubmitted={onSubmitted}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Field kind/i), { target: { value: 'OTHER' } });
    fireEvent.change(screen.getByLabelText(/Field other/i), { target: { value: 'note' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => expect(enroll).toHaveBeenCalled());
    const [, payload] = enroll.mock.calls[0];
    expect(payload.formValues).toMatchObject({ kind: 'OTHER', other: 'note' });
    expect(onSubmitted).toHaveBeenCalled();
  });
});

describe('LOOKUP (D12a)', () => {
  it('renders the mapped display value from the source field', () => {
    render(
      <SchemeFormRenderer
        schema={schema([
          field({ id: 'tier', type: 'DROPDOWN', options: ['Gold', 'Silver'] }),
          field({
            id: 'slab', type: 'LOOKUP', label: 'Slab',
            lookupSourceFieldId: 'tier', lookupMap: { Gold: '5% slab', Silver: '3% slab' },
          }),
        ])}
        context={baseCtx}
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Field tier/i), { target: { value: 'Gold' } });
    expect(screen.getByText('5% slab')).toBeInTheDocument();
  });
});

describe('PHONE_OTP lock for approved outlets (D16)', () => {
  it('pins to the owner number and hides the editable input', () => {
    render(
      <SchemeFormRenderer
        schema={schema([field({ id: 'ph', type: 'PHONE_OTP', label: 'Owner Mobile', otpRequired: true })])}
        context={{ ...baseCtx, outletApproved: true, ownerPhoneMasked: '••••1234' }}
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.getByText(/OTP to owner on file/i)).toBeInTheDocument();
    expect(screen.getByText(/••••1234/)).toBeInTheDocument();
    // No editable phone input is rendered for a pinned outlet.
    expect(screen.queryByLabelText('Owner Mobile')).not.toBeInTheDocument();
  });

  it('an un-approved outlet gets an editable number input + Send OTP', () => {
    render(
      <SchemeFormRenderer
        schema={schema([field({ id: 'ph', type: 'PHONE_OTP', label: 'Owner Mobile', otpRequired: true })])}
        context={{ ...baseCtx, outletApproved: false }}
        onSubmitted={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Owner Mobile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send otp/i })).toBeInTheDocument();
  });
});

describe('GPS on submit (B-MED-1)', () => {
  it('fills every empty GPS field — incl. a MANUAL-trigger one — when captureGpsOnSubmit is on', async () => {
    mockGeolocation({ lat: 12.34, lng: 56.78, accuracy: 5 });
    render(
      <SchemeFormRenderer
        schema={{
          captureGpsOnSubmit: true,
          requireOtp: false,
          fields: [field({ id: 'loc', type: 'GPS_POINT', label: 'Location', captureTrigger: 'MANUAL' })],
        }}
        context={baseCtx}
        onSubmitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(enroll).toHaveBeenCalled());
    const [, payload] = enroll.mock.calls[0];
    expect(payload.formValues.loc).toMatchObject({ lat: 12.34, lng: 56.78 });
  });
});

describe('hidden fields excluded from payload (B-MED-2)', () => {
  it('does not submit the value of a visibleWhen-hidden field', async () => {
    render(
      <SchemeFormRenderer
        schema={schema([
          field({ id: 'gate', type: 'DROPDOWN', options: ['stay', 'go'] }),
          field({ id: 'secret', type: 'TEXT', visibleWhen: { fieldId: 'gate', op: 'eq', value: 'go' } }),
        ])}
        initialValues={{ gate: 'stay', secret: 'stale' }}
        context={baseCtx}
        onSubmitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(enroll).toHaveBeenCalled());
    const [, payload] = enroll.mock.calls[0];
    // The visible gate field is submitted; the hidden field's stale value is not.
    expect(payload.formValues).toHaveProperty('gate', 'stay');
    expect(payload.formValues).not.toHaveProperty('secret');
  });
});

describe('media field → stored key', () => {
  it('uploads the picked file and submits the returned key as the field value', async () => {
    render(
      <SchemeFormRenderer
        schema={schema([field({ id: 'shot', type: 'CAMERA', label: 'Shopfront', required: true })])}
        context={baseCtx}
        onSubmitted={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('Shopfront') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'shop.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledWith('s1', file, undefined));
    await waitFor(() => expect(screen.getByText(/Captured/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(enroll).toHaveBeenCalled());
    const [, payload] = enroll.mock.calls[0];
    expect(payload.formValues.shot).toBe('scheme-media/c/photo.jpg');
  });
});

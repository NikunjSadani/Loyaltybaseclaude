/**
 * enrollment-form-renderer.test.tsx
 *
 * Component tests for EnrollmentFormRenderer.
 *
 * Key behaviours verified:
 *  1. Renders TEXT / NUMBER / DROPDOWN / DATE fields from props.
 *  2. Submit button disabled when required fields are empty.
 *  3. Submit button enabled when all required visible fields have values.
 *  4. Legacy path (no schemeId): calls onSubmit directly.
 *  5. Backend-wired path (schemeId provided):
 *       a. calls POST /api/schemes/:id/enroll with correct payload.
 *       b. calls onSubmit on success.
 *       c. shows error message on failure.
 *  6. DATA_DISPLAY field renders prefill value.
 *  7. Auto-filled locked field shows lock badge.
 *  8. Conditional visibility hides / shows field based on another field value.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EnrollmentFormRenderer } from './enrollment-form-renderer';
import type { FormField } from '@/lib/campaign';

// ─── Minimal field factories ──────────────────────────────────────────────────

function textField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: 'f-text',
    type: 'TEXT',
    label: 'Full Name',
    required: true,
    order: 0,
    autoFillFromExcel: false,
    autoFillEditable: true,
    ...overrides,
  };
}

function dropdownField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: 'f-drop',
    type: 'DROPDOWN',
    label: 'Shop Type',
    required: false,
    order: 1,
    options: ['Kirana', 'Pharmacy'],
    autoFillFromExcel: false,
    autoFillEditable: false,
    ...overrides,
  };
}

function numberField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: 'f-num',
    type: 'NUMBER',
    label: 'Area (sqft)',
    required: false,
    order: 2,
    autoFillFromExcel: false,
    autoFillEditable: false,
    ...overrides,
  };
}

// ─── Default wrapper props ────────────────────────────────────────────────────

interface RendererProps {
  fields?: FormField[];
  values?: Record<string, unknown>;
  onSubmit?: (v: Record<string, unknown>) => void;
  onChange?: (id: string, v: unknown) => void;
  schemeId?: string;
}

function makeProps(overrides: RendererProps = {}) {
  return {
    fields:          overrides.fields         ?? [textField()],
    isLoyaltyMember: true,
    prefillData:     {},
    values:          overrides.values         ?? {},
    onChange:        overrides.onChange       ?? vi.fn(),
    onSubmit:        overrides.onSubmit       ?? vi.fn(),
    schemeId:        overrides.schemeId,
  };
}

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  // stub localStorage.getItem for authHeader()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'test-token'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — field rendering', () => {
  it('renders a TEXT field label', () => {
    render(<EnrollmentFormRenderer {...makeProps()} />);
    expect(screen.getByText('Full Name')).toBeInTheDocument();
  });

  it('renders required star for required fields', () => {
    render(<EnrollmentFormRenderer {...makeProps({ fields: [textField({ required: true })] })} />);
    // The star is a <span> with text "*"
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('renders DROPDOWN options', () => {
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [dropdownField()], values: {} })}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('Kirana')).toBeInTheDocument();
    expect(screen.getByText('Pharmacy')).toBeInTheDocument();
  });

  it('renders NUMBER field as a number input', () => {
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [numberField({ required: false })], values: {} })}
      />,
    );
    const input = screen.getByLabelText('Area (sqft)');
    expect(input).toHaveAttribute('type', 'number');
  });

  it('renders DATA_DISPLAY field with prefill value', () => {
    const field: FormField = {
      id: 'f-dd',
      type: 'DATA_DISPLAY',
      label: 'Last Month Sales',
      required: false,
      order: 0,
      autoFillFromExcel: false,
      autoFillEditable: false,
      dataDisplayKey: 'last_month_sales',
    };
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [field], values: {} })}
        prefillData={{ last_month_sales: '500 cases' }}
      />,
    );
    expect(screen.getByText('500 cases')).toBeInTheDocument();
  });
});

describe('EnrollmentFormRenderer — auto-filled locked field', () => {
  it('shows lock badge for locked auto-fill field', () => {
    const field: FormField = {
      id: 'f-auto',
      type: 'TEXT',
      label: 'Pre-filled Field',
      required: false,
      order: 0,
      autoFillFromExcel: true,
      autoFillEditable: false,  // locked
    };
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [field], values: { 'f-auto': 'prefilled-value' } })}
      />,
    );
    expect(screen.getByTestId('lock-icon-f-auto')).toBeInTheDocument();
  });

  it('does NOT show lock badge for editable auto-fill field', () => {
    const field: FormField = {
      id: 'f-edit',
      type: 'TEXT',
      label: 'Editable Pre-filled',
      required: false,
      order: 0,
      autoFillFromExcel: true,
      autoFillEditable: true,  // editable
    };
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [field], values: { 'f-edit': 'some-value' } })}
      />,
    );
    expect(screen.queryByTestId('lock-icon-f-edit')).not.toBeInTheDocument();
  });
});

describe('EnrollmentFormRenderer — submit button state', () => {
  it('submit is disabled when a required field is empty', () => {
    render(
      <EnrollmentFormRenderer
        {...makeProps({ fields: [textField({ required: true })], values: {} })}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toBeDisabled();
  });

  it('submit is enabled when all required visible fields have values', () => {
    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [textField({ required: true })],
          values: { 'f-text': 'Jane Doe' },
        })}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).not.toBeDisabled();
  });
});

describe('EnrollmentFormRenderer — conditional visibility', () => {
  it('hides a field when its visibleWhen condition is not met', () => {
    const trigger: FormField = {
      id: 'f-type',
      type: 'DROPDOWN',
      label: 'Shop Type',
      required: false,
      order: 0,
      options: ['Kirana', 'Pharmacy'],
      autoFillFromExcel: false,
      autoFillEditable: false,
    };
    const conditional: FormField = {
      id: 'f-hidden',
      type: 'TEXT',
      label: 'Pharmacy License',
      required: false,
      order: 1,
      autoFillFromExcel: false,
      autoFillEditable: false,
      visibleWhen: { fieldId: 'f-type', op: 'eq', value: 'Pharmacy' },
    };
    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [trigger, conditional],
          // f-type = 'Kirana' → conditional should NOT be visible
          values: { 'f-type': 'Kirana' },
        })}
      />,
    );
    expect(screen.queryByLabelText('Pharmacy License')).not.toBeInTheDocument();
  });

  it('shows a field when its visibleWhen condition IS met', () => {
    const trigger: FormField = {
      id: 'f-type',
      type: 'DROPDOWN',
      label: 'Shop Type',
      required: false,
      order: 0,
      options: ['Kirana', 'Pharmacy'],
      autoFillFromExcel: false,
      autoFillEditable: false,
    };
    const conditional: FormField = {
      id: 'f-license',
      type: 'TEXT',
      label: 'Pharmacy License',
      required: false,
      order: 1,
      autoFillFromExcel: false,
      autoFillEditable: false,
      visibleWhen: { fieldId: 'f-type', op: 'eq', value: 'Pharmacy' },
    };
    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [trigger, conditional],
          values: { 'f-type': 'Pharmacy' },
        })}
      />,
    );
    expect(screen.getByLabelText('Pharmacy License')).toBeInTheDocument();
  });
});

describe('EnrollmentFormRenderer — legacy path (no schemeId)', () => {
  it('calls onSubmit directly without fetching when schemeId is absent', async () => {
    const onSubmit = vi.fn();
    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [textField({ required: true })],
          values: { 'f-text': 'Jane Doe' },
          onSubmit,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ 'f-text': 'Jane Doe' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('EnrollmentFormRenderer — backend-wired path (schemeId provided)', () => {
  it('POST /api/schemes/:id/enroll on submit success → calls onSubmit', async () => {
    const onSubmit = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { enrollment: { id: 'enr-1' } } }),
    } as Response);

    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [textField({ required: true })],
          values: { 'f-text': 'Jane Doe' },
          onSubmit,
          schemeId: 'sch-abc',
        })}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/schemes/sch-abc/enroll',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            enrollmentMode: 'SELF',
            formValues: { 'f-text': 'Jane Doe' },
          }),
        }),
      );
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ 'f-text': 'Jane Doe' }));
  });

  it('shows error message on backend failure', async () => {
    const onSubmit = vi.fn();
    mockFetch.mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ success: false, error: 'Form validation failed: Name required' }),
    } as Response);

    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [textField({ required: true })],
          values: { 'f-text': 'Jane Doe' },
          onSubmit,
          schemeId: 'sch-abc',
        })}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends SALES mode with targetPartnerId when targetPartnerId is provided', async () => {
    const onSubmit = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { enrollment: {} } }),
    } as Response);

    render(
      <EnrollmentFormRenderer
        {...makeProps({
          fields: [textField({ required: false })],
          values: {},
          onSubmit,
          schemeId: 'sch-abc',
        })}
        targetPartnerId="partner-xyz"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/schemes/sch-abc/enroll',
        expect.objectContaining({
          body: JSON.stringify({
            enrollmentMode: 'SALES',
            formValues: {},
            targetPartnerId: 'partner-xyz',
          }),
        }),
      );
    });
  });
});

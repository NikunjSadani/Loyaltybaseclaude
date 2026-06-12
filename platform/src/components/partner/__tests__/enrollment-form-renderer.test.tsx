/// <reference types="vitest/globals" />
/**
 * TDD — EnrollmentFormRenderer
 *
 * Tests cover:
 *   A) Field rendering by audience
 *   B) Required field validation gates the submit button
 *   C) DATA_DISPLAY renders value, no interactive input
 *   D) AUTO_POPULATED field: locked renders disabled input; editable renders enabled
 *   E) onChange fires for editable fields
 *   F) UPI_QR_SCAN renders text input + scan trigger button
 *   G) DROPDOWN renders select with admin-configured options
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnrollmentFormRenderer } from '../enrollment-form-renderer';
import type { FormField } from '@/lib/campaign';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeField = (overrides: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({
  label: `Field ${overrides.id}`,
  required: false,
  audience: 'ALL',
  autoFillFromExcel: false,
  autoFillEditable: false,
  order: 0,
  ...overrides,
});

const textField = makeField({ id: 'f-text', type: 'TEXT', label: 'Shop Name', required: true });
const optionalText = makeField({ id: 'f-opt', type: 'TEXT', label: 'Notes', required: false });
const dropdownField = makeField({ id: 'f-drop', type: 'DROPDOWN', label: 'Shop Type', required: true, options: ['Kirana', 'Supermarket', 'Medical'] });
const dataDisplayField = makeField({ id: 'f-data', type: 'DATA_DISPLAY', label: 'Last Month Sales', required: false, dataDisplayKey: 'last_month_sales' });
const autoLockedField = makeField({ id: 'f-auto-locked', type: 'TEXT', label: 'GSTIN', required: false, autoFillFromExcel: true, autoFillEditable: false });
const autoEditableField = makeField({ id: 'f-auto-edit', type: 'TEXT', label: 'Target Qty', required: false, autoFillFromExcel: true, autoFillEditable: true });
const loyaltyOnlyField = makeField({ id: 'f-loyalty', type: 'TEXT', label: 'Loyalty PIN', required: false, audience: 'LOYALTY_MEMBERS' });
const nonKycField = makeField({ id: 'f-nonkyc', type: 'TEXT', label: 'Shop Ref Code', required: false, audience: 'NON_LOYALTY_MEMBERS' });
const upiField = makeField({ id: 'f-upi', type: 'UPI_QR_SCAN', label: 'UPI ID', required: true });

// ── A) Audience filtering ─────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — audience filtering', () => {
  it('shows ALL fields to a loyalty member', () => {
    render(
      <EnrollmentFormRenderer
        fields={[textField, loyaltyOnlyField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/shop name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/loyalty pin/i)).toBeInTheDocument();
  });

  it('hides LOYALTY_MEMBERS-only fields from a non-loyalty partner', () => {
    render(
      <EnrollmentFormRenderer
        fields={[textField, loyaltyOnlyField]}
        isLoyaltyMember={false}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/shop name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/loyalty pin/i)).not.toBeInTheDocument();
  });

  it('shows NON_LOYALTY_MEMBERS fields only to non-loyalty partners', () => {
    render(
      <EnrollmentFormRenderer
        fields={[textField, nonKycField]}
        isLoyaltyMember={false}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByLabelText(/shop ref code/i)).toBeInTheDocument();
  });

  it('hides NON_LOYALTY_MEMBERS fields from loyalty members', () => {
    render(
      <EnrollmentFormRenderer
        fields={[nonKycField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/shop ref code/i)).not.toBeInTheDocument();
  });
});

// ── B) Submit button gate ─────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — submit button', () => {
  it('disables submit button when a required TEXT field is empty', () => {
    render(
      <EnrollmentFormRenderer
        fields={[textField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-text': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /submit|enrol/i })).toBeDisabled();
  });

  it('enables submit button when all required fields have values', () => {
    render(
      <EnrollmentFormRenderer
        fields={[textField, optionalText]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-text': 'Sharma Kirana', 'f-opt': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /submit|enrol/i })).not.toBeDisabled();
  });

  it('calls onSubmit when the button is clicked and form is valid', () => {
    const onSubmit = vi.fn();
    render(
      <EnrollmentFormRenderer
        fields={[optionalText]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /submit|enrol/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// ── C) DATA_DISPLAY ───────────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — DATA_DISPLAY field', () => {
  it('renders the field label', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dataDisplayField]}
        isLoyaltyMember={true}
        prefillData={{ last_month_sales: '₹1,24,500' }}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/last month sales/i)).toBeInTheDocument();
  });

  it('renders the outlet data value', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dataDisplayField]}
        isLoyaltyMember={true}
        prefillData={{ last_month_sales: '₹1,24,500' }}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText('₹1,24,500')).toBeInTheDocument();
  });

  it('does not render an input element for DATA_DISPLAY', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dataDisplayField]}
        isLoyaltyMember={true}
        prefillData={{ last_month_sales: '₹1,24,500' }}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows "—" when data key is missing from prefillData', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dataDisplayField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{}}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

// ── D) AUTO_POPULATED field ───────────────────────────────────────────────────

describe('EnrollmentFormRenderer — AUTO_POPULATED fields', () => {
  it('renders a disabled input when autoFillEditable is false', () => {
    render(
      <EnrollmentFormRenderer
        fields={[autoLockedField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-auto-locked': '27AAPFU0939F1ZV' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByDisplayValue('27AAPFU0939F1ZV');
    expect(input).toBeDisabled();
  });

  it('renders an enabled input when autoFillEditable is true', () => {
    render(
      <EnrollmentFormRenderer
        fields={[autoEditableField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-auto-edit': '850' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByDisplayValue('850');
    expect(input).not.toBeDisabled();
  });

  it('shows a lock icon badge for locked auto-populated fields', () => {
    render(
      <EnrollmentFormRenderer
        fields={[autoLockedField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-auto-locked': '27AAPFU0939F1ZV' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    // Lock icon or "auto-filled" label
    expect(screen.getByTestId('lock-icon-f-auto-locked')).toBeInTheDocument();
  });
});

// ── E) onChange ───────────────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — onChange', () => {
  it('calls onChange with field id and new value when text input changes', () => {
    const onChange = vi.fn();
    render(
      <EnrollmentFormRenderer
        fields={[optionalText]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-opt': '' }}
        onChange={onChange}
        onSubmit={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
    expect(onChange).toHaveBeenCalledWith('f-opt', 'Hello');
  });

  it('calls onChange for dropdown selection', () => {
    const onChange = vi.fn();
    render(
      <EnrollmentFormRenderer
        fields={[dropdownField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-drop': '' }}
        onChange={onChange}
        onSubmit={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Kirana' } });
    expect(onChange).toHaveBeenCalledWith('f-drop', 'Kirana');
  });
});

// ── F) UPI_QR_SCAN field ──────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — UPI_QR_SCAN field', () => {
  it('renders the field label', () => {
    render(
      <EnrollmentFormRenderer
        fields={[upiField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-upi': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/upi id/i)).toBeInTheDocument();
  });

  it('renders a text input for manual UPI entry', () => {
    render(
      <EnrollmentFormRenderer
        fields={[upiField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-upi': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders a "Scan QR" button', () => {
    render(
      <EnrollmentFormRenderer
        fields={[upiField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-upi': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /scan qr/i })).toBeInTheDocument();
  });

  it('calls onChange with the UPI value when typed manually', () => {
    const onChange = vi.fn();
    render(
      <EnrollmentFormRenderer
        fields={[upiField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-upi': '' }}
        onChange={onChange}
        onSubmit={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9876543210@paytm' } });
    expect(onChange).toHaveBeenCalledWith('f-upi', '9876543210@paytm');
  });
});

// ── G) DROPDOWN ───────────────────────────────────────────────────────────────

describe('EnrollmentFormRenderer — DROPDOWN field', () => {
  it('renders a select element', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dropdownField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-drop': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('renders all admin-configured options', () => {
    render(
      <EnrollmentFormRenderer
        fields={[dropdownField]}
        isLoyaltyMember={true}
        prefillData={{}}
        values={{ 'f-drop': '' }}
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByRole('option', { name: 'Kirana' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Supermarket' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Medical' })).toBeInTheDocument();
  });
});

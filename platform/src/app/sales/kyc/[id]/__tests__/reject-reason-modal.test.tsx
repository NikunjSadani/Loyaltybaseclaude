/// <reference types="vitest/globals" />
/**
 * RRM — Sales senior-reject modal (RejectionModal)
 *
 * A SENIOR (SO/ASM/RSM) rejecting a KYC picks from a MULTI-SELECT list of preset
 * reasons (with an "Others" free-text option), minimising open typing. The ticked
 * reasons are joined into ONE string and handed to onConfirm — the page then POSTs
 * it unchanged as the existing { reason } payload.
 *
 * RRM1: selecting two presets then Confirm calls onConfirm with them joined by "; "
 * RRM2: Confirm is disabled until at least one reason is selected
 * RRM3: choosing Others reveals a free-text box; Confirm stays disabled until it has
 *       text, then onConfirm receives "Others: <text>"
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { KYC_REJECTION_REASONS } from '@/lib/kyc-rejection-reasons';
import { RejectionModal } from '../page';

const [REASON_A, REASON_B] = KYC_REJECTION_REASONS;

describe('RRM — sales senior-reject modal', () => {
  it('RRM1: selecting two presets then Confirm joins them with "; "', () => {
    const onConfirm = vi.fn();
    render(<RejectionModal onConfirm={onConfirm} onCancel={() => {}} />);

    fireEvent.click(screen.getByText(REASON_A));
    fireEvent.click(screen.getByText(REASON_B));
    fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(`${REASON_A}; ${REASON_B}`);
  });

  it('RRM2: Confirm is disabled when nothing is selected', () => {
    const onConfirm = vi.fn();
    render(<RejectionModal onConfirm={onConfirm} onCancel={() => {}} />);

    const confirm = screen.getByRole('button', { name: /confirm rejection/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    // Selecting one preset enables it.
    fireEvent.click(screen.getByText(REASON_A));
    expect(confirm).not.toBeDisabled();
  });

  it('RRM3: Others reveals a free-text box and appends "Others: <text>"', () => {
    const onConfirm = vi.fn();
    render(<RejectionModal onConfirm={onConfirm} onCancel={() => {}} />);

    const confirm = screen.getByRole('button', { name: /confirm rejection/i });

    // No textarea until Others is chosen.
    expect(screen.queryByPlaceholderText(/type the specific reason/i)).toBeNull();

    fireEvent.click(screen.getByText('Others'));
    // Others ticked but empty text → still disabled.
    expect(confirm).toBeDisabled();

    const box = screen.getByPlaceholderText(/type the specific reason/i);
    fireEvent.change(box, { target: { value: 'duplicate outlet' } });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Others: duplicate outlet');
  });
});

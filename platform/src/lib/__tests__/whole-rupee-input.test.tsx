/// <reference types="vitest/globals" />
/**
 * WR — whole-rupee redemption amount inputs (owner decision 2026-11-11, all tenants).
 * Typing or pasting "750.5" must never leave a decimal (or "7505") in the field.
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import {
  WHOLE_RUPEE_INVALID_MESSAGE,
  isWholeRupeeInvalid,
  wholeRupeeAmount,
  wholeRupeeDigits,
  wholeRupeeInputProps,
} from '../whole-rupee-input';

function Harness() {
  const [v, setV] = useState('');
  const [committed, setCommitted] = useState(false);
  const showError = committed && isWholeRupeeInvalid(v);
  return (
    <>
      <input
        aria-label="amt"
        aria-invalid={showError || undefined}
        value={v}
        {...wholeRupeeInputProps(setV, { onCommit: () => setCommitted(true) })}
      />
      {showError && <p role="alert">{WHOLE_RUPEE_INVALID_MESSAGE}</p>}
      <button disabled={!((wholeRupeeAmount(v) ?? 0) > 0)}>Redeem</button>
    </>
  );
}

describe('WR — wholeRupeeDigits (never guesses)', () => {
  it.each([
    ['', ''],
    ['750', '750'],
    ['1,250', '1250'],
    ['12,500', '12500'],
    ['125,000', '125000'],
    ['1,250,000', '1250000'],
    ['1,25,000', '125000'],
    ['12,34,567', '1234567'],
    ['Rs. 1,250', '1250'],
    ['Rs.1,250', '1250'],
    ['₹ 1,250', '1250'],
    ['INR 1250', '1250'],
    ['rs 900', '900'],
  ])('%s → %s', (input, out) => {
    expect(wholeRupeeDigits(input)).toBe(out);
  });
  it.each(['750,5', '750,', '1,', '1,2', '12,50', '1,2345', '750.5', '₹1,250.50', '1,250.75', '.5', '7e2', 'abc', '1 250'])(
    '%s → invalid (null)',
    (input) => {
      expect(wholeRupeeDigits(input)).toBeNull();
      expect(isWholeRupeeInvalid(input)).toBe(true);
    },
  );
});

describe('WR — wholeRupeeInputProps', () => {
  it('WR1: typing "750.5" yields "750" (the "." and the digits after it are dropped)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    expect(el.value).toBe('750');
  });

  it('WR2: after a refused ".", Backspace ends the fraction state and typing resumes', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '75.9{Backspace}1');
    expect(el.value).toBe('71');
  });

  it('WR3: pasting a decimal ("750.5", "₹1,250.50") keeps the text, shows "Check the amount", disables submit', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('750.5');
    expect(el.value).toBe('750.5'); // never shrunk to 750
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeDisabled();
    expect(wholeRupeeAmount(el.value)).toBeNull();
    await userEvent.clear(el);
    await userEvent.paste('₹1,250.50');
    expect(el.value).toBe('1,250.50');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
  });

  it('WR3b: pasting "Rs. 1,250" / "Rs.1,250" / "₹ 1,250" / "INR 1250" → 1250, no error', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const text of ['Rs. 1,250', 'Rs.1,250', '₹ 1,250', 'INR 1250']) {
      await userEvent.clear(el);
      await userEvent.paste(text);
      expect(el.value).toBe('1250');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Redeem' })).toBeEnabled();
    }
  });

  it('WR4: "e", "+", "-" are refused', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1e+-2');
    expect(el.value).toBe('12');
  });

  it('L1 regression: typing "1,250" key-by-key keeps the comma while typing and commits 1250 on blur', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,');
    expect(el.value).toBe('1,'); // a trailing comma never truncates while typing
    await userEvent.type(el, '250');
    expect(el.value).toBe('1,250');
    expect(wholeRupeeAmount(el.value)).toBe(1250); // a reader before blur already gets 1250
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it('L1: typing "750,5" then blur → kept as typed, "Check the amount", Redeem disabled (never 750 / 7505)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750,5');
    expect(el.value).toBe('750,5');
    expect(wholeRupeeAmount(el.value)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // not flagged while still typing
    fireEvent.blur(el);
    expect(el.value).toBe('750,5');
    expect(el).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeDisabled();
  });

  it('L1: "1,2" on blur is invalid (never shrinks to ₹1); fixing it to "1,250" clears the error', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,2');
    fireEvent.blur(el);
    expect(el.value).toBe('1,2');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
    await userEvent.type(el, '50');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeEnabled();
  });

  it('caret: a "," typed mid-value keeps the caret right after it', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1250');
    el.setSelectionRange(1, 1);
    await userEvent.keyboard(',');
    expect(el.value).toBe('1,250');
    expect(el.selectionStart).toBe(2);
    expect(el.selectionEnd).toBe(2);
  });

  it('L1: Enter commits like blur ("1,25,000" typed → 125000)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,25,000{Enter}');
    expect(el.value).toBe('125000');
  });

  it('L1: pasting "1,25,000" → 125000 at once', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('1,25,000');
    expect(el.value).toBe('125000');
  });

  it('L1 (Android): change "750," then "7505" keeps the comma ("750,5"); blur keeps it + flags it', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '750' } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '750,' } });
    expect(el.value).toBe('750,');
    fireEvent.change(el, { target: { value: '750,5' } });
    expect(el.value).toBe('750,5');
    fireEvent.blur(el);
    expect(el.value).toBe('750,5');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
  });

  it('L1 (Android beforeinput): data "," is inserted as-is (no fraction state); data "." starts it; delete ends it', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '750' } });
    el.setSelectionRange(3, 3);
    const bi = (data: string | null, inputType: string) =>
      fireEvent(el, new InputEvent('beforeinput', { data, inputType, bubbles: true, cancelable: true }));
    bi(',', 'insertText');
    expect(el.value).toBe('750,');
    expect(el.dataset.fraction).toBeUndefined();
    fireEvent.change(el, { target: { value: '750' } });
    el.setSelectionRange(3, 3);
    bi('.', 'insertText');
    expect(el.value).toBe('750');
    expect(el.dataset.fraction).toBe('1');
    // a digit insert while in the fraction state is refused (cancelled)
    expect(bi('5', 'insertText')).toBe(false);
    bi(null, 'deleteContentBackward');
    expect(el.dataset.fraction).toBeUndefined();
  });

  it('RC-L2: a "." or "," on an EMPTY field is dropped and does not start the fraction state (".5" → "5")', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '.5');
    expect(el.value).toBe('5');
    await userEvent.clear(el);
    await userEvent.type(el, ',7');
    expect(el.value).toBe('7');
  });

  it('RC-L3: inserting "1.5" over a selected "500" splices at the selection (paste or a multi-char insert → kept + invalid)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '500' } });
    el.focus();
    el.setSelectionRange(0, 3);
    await userEvent.paste('1.5');
    expect(el.value).toBe('1.5'); // paste path: a pasted decimal is flagged, never shrunk
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
    // same splice via an Android-style beforeinput insert
    fireEvent.change(el, { target: { value: '500' } });
    el.setSelectionRange(0, 3);
    fireEvent(el, new InputEvent('beforeinput', { data: '1.5', inputType: 'insertText', bubbles: true, cancelable: true }));
    expect(el.value).toBe('1.5'); // F7: a multi-char insert carrying "." is a paste — never truncated to "1"
    expect(wholeRupeeAmount(el.value)).toBeNull();
  });

  it.each([
    ['₹1,250.00', '1250'],
    ['1,250.0', '1250'],
    ['1,250/-', '1250'],
    ['Rs 1250/-', '1250'],
    ['Rs. 1,250.00/-', '1250'],
  ])('F7c: pasted %s → accepted as whole %s', async (text, out) => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste(text);
    expect(el.value).toBe(out);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['1,250.5', '1,250.000', '1.05', '1250/-x'])('F7c: %s stays invalid', (text) => {
    expect(wholeRupeeAmount(text)).toBeNull();
  });

  it('F7a: a FLAGGED invalid text is edited verbatim — typing "5" / "." / "," never rewrites or shrinks it', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('750.5');
    expect(el.value).toBe('750.5');
    await userEvent.type(el, '5');
    expect(el.value).toBe('750.55'); // NOT "750" / "7505"
    await userEvent.type(el, '.');
    expect(el.value).toBe('750.55.');
    await userEvent.type(el, ',');
    expect(el.value).toBe('750.55.,');
    expect(wholeRupeeAmount(el.value)).toBeNull();
    // Android change path while flagged: kept verbatim too.
    fireEvent.change(el, { target: { value: '750.555' } });
    expect(el.value).toBe('750.555');
  });

  it('F7a: the flag ends once the text is valid — then normal typing rules resume', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,2');
    fireEvent.blur(el); // committed invalid → flagged
    expect(el.dataset.invalid).toBe('1');
    await userEvent.type(el, '50');
    expect(el.value).toBe('1,250');
    expect(el.dataset.invalid).toBeUndefined();
    await userEvent.type(el, '.9');
    expect(el.value).toBe('1,250'); // "." blocked again (fraction dropped)
  });

  it('F7b (Android onChange): a "." typed MID-value is rejected (previous value kept), never truncated', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const v of ['1', '12', '125', '1250']) fireEvent.change(el, { target: { value: v } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '12.50' } });
    expect(el.value).toBe('1250'); // NOT "12"
    expect(el.dataset.fraction).toBeUndefined();
    // a "." appended at the end is also rejected (value kept) and swallows the next digit
    fireEvent.change(el, { target: { value: '1250.' } });
    expect(el.value).toBe('1250');
    fireEvent.change(el, { target: { value: '12505' } });
    expect(el.value).toBe('1250');
  });

  it('WR6 (Android, keydown "Unidentified"): change events "750." then "7505" → stays 750; a deletion ends the fraction', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const v of ['7', '75', '750']) fireEvent.change(el, { target: { value: v } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '750.' } });
    expect(el.value).toBe('750');
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '7505' } });
    expect(el.value).toBe('750'); // never 7505
    fireEvent.change(el, { target: { value: '75055' } });
    expect(el.value).toBe('750');
    fireEvent.change(el, { target: { value: '75' } }); // backspace (a deletion) ends the fraction state
    fireEvent.change(el, { target: { value: '751' } });
    expect(el.value).toBe('751');
  });

  it('WR7 (Android): a "," that IS a thousands separator ("1,250") is kept while typing and stripped on blur', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '1,250' } });
    expect(el.value).toBe('1,250');
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it.each([
    ['1,250', 1250],
    ['750,5', null],
    ['1,25,000', 125000],
    ['1,', null],
    ['', 0],
  ])('wholeRupeeAmount(%s) → %s', (input, out) => {
    expect(wholeRupeeAmount(input)).toBe(out);
  });

  it('WR5: numeric keypad hints are set', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt');
    expect(el).toHaveAttribute('inputmode', 'numeric');
    expect(el).toHaveAttribute('pattern', '[0-9]*');
  });
});

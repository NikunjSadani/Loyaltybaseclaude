/// <reference types="vitest/globals" />
/**
 * WR — whole-rupee redemption amount inputs (owner decision 2026-11-11, all tenants).
 * Decimals are never accepted and an amount is never silently changed: a typed / pasted "750.5"
 * stays visible and is INVALID ("Check the amount — whole rupees only"), never 750 / 7505.
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  WHOLE_RUPEE_INVALID_MESSAGE,
  isWholeRupeeInvalid,
  wholeRupeeAmount,
  wholeRupeeDigits,
  wholeRupeeInputProps,
  useWholeRupeeField,
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

/** The real hook, as the 4 callers use it: submit refused (and explained) for an invalid text. */
function HookHarness({ onSubmit }: { onSubmit: (amount: number) => void }) {
  const f = useWholeRupeeField();
  return (
    <>
      <input aria-label="amt" value={f.value} {...f.inputProps} />
      {f.showInvalid && <p role="alert">{WHOLE_RUPEE_INVALID_MESSAGE}</p>}
      <button onClick={() => { if (f.checkBeforeSubmit()) onSubmit(f.amount ?? 0); }}>Redeem</button>
      <button onClick={() => f.reset('')}>Reset</button>
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
  it.each([
    '750,5', '750,', '1,', '1,2', '12,50', '1,2345', '750.5', '₹1,250.50', '1,250.75', '.5', '7e2', 'abc', '1 250',
    // item 10: a grouped number starts 1-9
    '0,500', '00,500', '0,50,000', '01,250',
  ])('%s → invalid (null)', (input) => {
    expect(wholeRupeeDigits(input)).toBeNull();
    expect(isWholeRupeeInvalid(input)).toBe(true);
  });
});

describe('WR — wholeRupeeInputProps', () => {
  it('the message reads "Check the amount — whole rupees only"', () => {
    expect(WHOLE_RUPEE_INVALID_MESSAGE).toBe('Check the amount — whole rupees only');
  });

  it('WR1: typing "750.5" keeps it VISIBLE (never 750 / 7505); blur → invalid, "Check the amount"', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    expect(el.value).toBe('750.5');
    expect(screen.queryByRole('alert')).toBeNull(); // never mid-typing
    fireEvent.blur(el);
    expect(el.value).toBe('750.5');
    expect(screen.getByRole('alert')).toHaveTextContent(WHOLE_RUPEE_INVALID_MESSAGE);
    expect(wholeRupeeAmount(el.value)).toBeNull();
  });

  it('WR1b (hook): typed "750.5" + submit tap → "Check the amount — whole rupees only", NOTHING submitted', async () => {
    const onSubmit = vi.fn();
    render(<HookHarness onSubmit={onSubmit} />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    await userEvent.click(await screen.findByRole('button', { name: 'Redeem' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount — whole rupees only');
    expect(el.value).toBe('750.5');
    // Fixing it (delete ".5") → the next tap submits the whole amount.
    await userEvent.type(el, '{Backspace}{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Redeem' }));
    expect(onSubmit).toHaveBeenCalledWith(750);
  });

  it('WR2: a typed "." is kept like any character; Backspace removes it and typing continues', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '75.9{Backspace}{Backspace}1');
    expect(el.value).toBe('751');
    await userEvent.clear(el);
    await userEvent.type(el, '.5');
    expect(el.value).toBe('.5'); // never shrunk to "5"
    fireEvent.blur(el);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('WR3: pasting a decimal ("750.5", "₹1,250.50") keeps the text, shows "Check the amount", disables submit', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('750.5');
    expect(el.value).toBe('750.5'); // never shrunk to 750
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount');
    expect(await screen.findByRole('button', { name: 'Redeem' })).toBeDisabled();
    expect(wholeRupeeAmount(el.value)).toBeNull();
    await userEvent.clear(el);
    await userEvent.paste('₹1,250.50');
    expect(el.value).toBe('1,250.50');
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount');
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

  it('WR4: while typing only digits , . are accepted ("e", "+", "-", letters, space, "₹" refused)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1e+-a ₹R2');
    expect(el.value).toBe('12');
  });

  it('item 9: once FLAGGED invalid, letters are still refused (typed and via the change path)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    fireEvent.blur(el);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.type(el, 'xR5');
    expect(el.value).toBe('750.55');
    fireEvent.change(el, { target: { value: '750.55Rs' } });
    expect(el.value).toBe('750.55');
    // Deleting is always allowed — even out of a pasted text holding letters.
    await userEvent.clear(el);
    await userEvent.paste('12 abc');
    expect(el.value).toBe('12 abc');
    fireEvent.change(el, { target: { value: '12 ab' } });
    expect(el.value).toBe('12 ab');
    fireEvent.change(el, { target: { value: '12 abz' } });
    expect(el.value).toBe('12 ab');
  });

  it('L1 regression: typing "1,250" key-by-key keeps the comma while typing and commits 1250 on blur', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1,');
    expect(el.value).toBe('1,');
    await userEvent.type(el, '250');
    expect(el.value).toBe('1,250');
    expect(wholeRupeeAmount(el.value)).toBe(1250);
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it('L1: typing "750,5" then blur → kept as typed, "Check the amount", Redeem disabled (never 750 / 7505)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750,5');
    expect(el.value).toBe('750,5');
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('item 10: "0,500" / "00,500" typed → invalid on blur (grouped numbers start 1-9)', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const t of ['0,500', '00,500']) {
      await userEvent.clear(el);
      await userEvent.type(el, t);
      fireEvent.blur(el);
      expect(el.value).toBe(t);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    }
  });

  it('caret: a "," typed mid-value lands there and the caret stays right after it', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1250');
    el.setSelectionRange(1, 1);
    await userEvent.keyboard(',');
    expect(el.value).toBe('1,250');
    expect(el.selectionStart).toBe(2);
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

  it('Android (change path): "750." then "750.5" are kept verbatim; blur flags it', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    for (const v of ['7', '75', '750']) fireEvent.change(el, { target: { value: v } });
    fireEvent.keyDown(el, { key: 'Unidentified' });
    fireEvent.change(el, { target: { value: '750.' } });
    expect(el.value).toBe('750.');
    fireEvent.change(el, { target: { value: '750.5' } });
    expect(el.value).toBe('750.5');
    fireEvent.change(el, { target: { value: '12.50' } }); // a mid-value "." too — never truncated
    expect(el.value).toBe('12.50');
    fireEvent.blur(el);
    expect(el.value).toBe('12.50');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
  });

  it('Android (beforeinput): a single "," / "." / digit insert is NOT cancelled; a letter is', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    const bi = (data: string | null, inputType: string) =>
      fireEvent(el, new InputEvent('beforeinput', { data, inputType, bubbles: true, cancelable: true }));
    expect(bi(',', 'insertText')).toBe(true);
    expect(bi('.', 'insertText')).toBe(true);
    expect(bi('5', 'insertText')).toBe(true);
    expect(bi('a', 'insertText')).toBe(false);
    expect(bi(null, 'deleteContentBackward')).toBe(true);
  });

  it('item 8: a multi-char insert (IME / autocorrect) is left to the browser, then the value is checked — no duplication', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '1250' } });
    el.setSelectionRange(4, 4);
    const bi = (data: string, inputType: string) =>
      fireEvent(el, new InputEvent('beforeinput', { data, inputType, bubbles: true, cancelable: true }));
    // Autocorrect replacing the whole word "1250" with "1250.": not cancelled, not spliced at the caret.
    expect(bi('1250.', 'insertReplacementText')).toBe(true);
    expect(bi('1250.', 'insertCompositionText')).toBe(true);
    expect(bi('1.5', 'insertText')).toBe(true);
    expect(el.value).toBe('1250'); // the handler itself wrote nothing (never "12501250.")
    // The browser applies the replacement → onChange keeps the resulting value verbatim.
    fireEvent.change(el, { target: { value: '1250.' } });
    expect(el.value).toBe('1250.');
    expect(wholeRupeeAmount(el.value)).toBeNull();
    // A multi-char replacement holding letters is treated like a paste: kept + flagged invalid.
    fireEvent.change(el, { target: { value: 'twelve' } });
    expect(el.value).toBe('twelve');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
    // A SINGLE added letter is still refused.
    fireEvent.change(el, { target: { value: '' } });
    fireEvent.change(el, { target: { value: '5' } });
    fireEvent.change(el, { target: { value: '5x' } });
    expect(el.value).toBe('5');
  });

  it.each([
    ['₹1,250', '1250'],
    ['Rs 1250', '1250'],
    ['Rs. 1,250.00/-', '1250'],
    ['1,25,000', '125000'],
  ])('Android clipboard chip: insertText %s (no paste event) → normalised like a paste → %s', (text, out) => {
    render(<HookHarness onSubmit={() => undefined} />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    // The chip arrives as a multi-char insertText: not cancelled by beforeinput…
    expect(fireEvent(el, new InputEvent('beforeinput', { data: text, inputType: 'insertText', bubbles: true, cancelable: true }))).toBe(true);
    // …the browser applies it, and onChange interprets the inserted run.
    fireEvent.change(el, { target: { value: text } });
    expect(el.value).toBe(out);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Android clipboard chip: an invalid multi-char insert ("₹1,250.50") is kept (marker stripped) + flagged', () => {
    render(<HookHarness onSubmit={() => undefined} />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '₹1,250.50' } });
    expect(el.value).toBe('1,250.50');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount');
  });

  it('Android clipboard chip: spliced where it landed ("12" + chip "₹1,250" at the end → 121250)', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '1' } });
    fireEvent.change(el, { target: { value: '12' } });
    fireEvent.change(el, { target: { value: '12₹1,250' } });
    expect(el.value).toBe('121250');
  });

  it('a REFUSED keystroke keeps the "Check the amount" flag; a real edit clears it', async () => {
    render(<HookHarness onSubmit={() => undefined} />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '750.5');
    fireEvent.blur(el);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Change path (Android): a single letter added → refused, text kept, flag kept.
    fireEvent.change(el, { target: { value: '750.5x' } });
    expect(el.value).toBe('750.5');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Keydown path: a refused letter key changes nothing either.
    await userEvent.type(el, 'q');
    expect(el.value).toBe('750.5');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // A real edit clears it.
    await userEvent.type(el, '{Backspace}');
    expect(el.value).toBe('750.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('RC-L3: pasting "1.5" over a selected "500" splices at the selection → kept + invalid', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.change(el, { target: { value: '500' } });
    el.focus();
    el.setSelectionRange(0, 3);
    await userEvent.paste('1.5');
    expect(el.value).toBe('1.5');
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount');
    // Android clipboard-suggestion paste (beforeinput insertFromPaste) — same splice.
    fireEvent.change(el, { target: { value: '500' } });
    el.setSelectionRange(0, 3);
    fireEvent(el, new InputEvent('beforeinput', { data: '1.5', inputType: 'insertFromPaste', bubbles: true, cancelable: true }));
    expect(el.value).toBe('1.5');
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

  it('item 7: reset() forgets the old text — a refused edit afterwards can never resurrect it', async () => {
    render(<HookHarness onSubmit={() => undefined} />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '9999');
    await userEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    expect(el.value).toBe('');
    expect(el.dataset.last).toBeUndefined();
    // A refused (letter-adding) change now restores the CURRENT text (''), never "9999".
    fireEvent.change(el, { target: { value: 'x' } });
    expect(el.value).toBe('');
  });

  it('WR7 (Android): a "," that IS a thousands separator ("1,250") is kept while typing and stripped on blur', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    // Key by key (one char per change — a multi-char insert is paste-normalised at once instead).
    for (const v of ['1', '1,', '1,2', '1,25', '1,250']) fireEvent.change(el, { target: { value: v } });
    expect(el.value).toBe('1,250');
    fireEvent.blur(el);
    expect(el.value).toBe('1250');
  });

  it.each([
    ['1,250', 1250],
    ['750,5', null],
    ['1,25,000', 125000],
    ['1,', null],
    ['0,500', null],
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

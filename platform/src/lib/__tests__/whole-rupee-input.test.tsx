/// <reference types="vitest/globals" />
/**
 * WR — whole-rupee redemption amount inputs (owner decision 2026-11-11, all tenants).
 * Typing or pasting "750.5" must never leave a decimal (or "7505") in the field.
 */
import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { wholeRupeeInputProps, wholeRupeesFromText } from '../whole-rupee-input';

function Harness() {
  const [v, setV] = useState('');
  return <input aria-label="amt" value={v} {...wholeRupeeInputProps(setV)} />;
}

describe('WR — wholeRupeesFromText', () => {
  it.each([
    ['750.5', '750'],
    ['1,250.75', '1250'],
    ['₹ 900', '900'],
    ['7e2', '72'],
    ['.5', ''],
    ['', ''],
  ])('%s → %s', (input, out) => {
    expect(wholeRupeesFromText(input)).toBe(out);
  });
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

  it('WR3: pasting "750.5" yields "750"; pasting "1,250.75" yields "1250"', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.paste('750.5');
    expect(el.value).toBe('750');
    await userEvent.clear(el);
    await userEvent.paste('1,250.75');
    expect(el.value).toBe('1250');
  });

  it('WR4: "e", "+", "-", "," are refused', async () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt') as HTMLInputElement;
    await userEvent.type(el, '1e+-,2');
    expect(el.value).toBe('12');
  });

  it('WR5: numeric keypad hints are set', () => {
    render(<Harness />);
    const el = screen.getByLabelText('amt');
    expect(el).toHaveAttribute('inputmode', 'numeric');
    expect(el).toHaveAttribute('pattern', '[0-9]*');
  });
});

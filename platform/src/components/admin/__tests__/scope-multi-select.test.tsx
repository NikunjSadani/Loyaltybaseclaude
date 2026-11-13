/// <reference types="vitest/globals" />
/**
 * APPLIES-TO §6 — the shared ScopeMultiSelect (lifted from the Sales Import KPI editor).
 * Run: npx vitest run src/components/admin/__tests__/scope-multi-select.test.tsx
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ScopeMultiSelect, type ScopeOption } from '../scope-multi-select';

function Harness({ initial = [] as string[], options, ...rest }: { initial?: string[]; options: ScopeOption[] } & Partial<React.ComponentProps<typeof ScopeMultiSelect>>) {
  const [v, setV] = useState(initial);
  return <ScopeMultiSelect label="Programs" options={options} values={v} onChange={setV} {...rest} />;
}

const OPTS: ScopeOption[] = [
  { value: 'Unnati', label: 'Unnati' },
  { value: 'Pragati', label: 'Pragati', note: '(not in settings list)' },
];

describe('ScopeMultiSelect', () => {
  it('is an accessible group named by its legend; ticks and unticks', () => {
    const onChange = vi.fn();
    render(<ScopeMultiSelect label="Programs" options={OPTS} values={[]} onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Programs' });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Unnati' }));
    expect(onChange).toHaveBeenCalledWith(['Unnati']);
  });

  it('matches saved values case/space-insensitively and unticks them', () => {
    render(<Harness initial={[' unnati ']} options={OPTS} />);
    const box = screen.getByRole('checkbox', { name: 'Unnati' });
    expect(box).toBeChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('shows the "(not in settings list)" note next to the label', () => {
    render(<Harness options={OPTS} />);
    expect(screen.getByRole('checkbox', { name: /Pragati.*not in settings list/ })).toBeInTheDocument();
  });

  it('a selected value no longer offered stays listed + ticked with the stale suffix, and is removable', () => {
    render(<Harness initial={['Gone']} options={OPTS} staleSuffix="(not offered now)" />);
    const stale = screen.getByRole('checkbox', { name: 'Gone (not offered now)' });
    expect(stale).toBeChecked();
    fireEvent.click(stale);
    expect(screen.queryByRole('checkbox', { name: /Gone/ })).not.toBeInTheDocument();
  });

  it('default stale suffix is the Sales Import one; an empty suffix shows the bare value', () => {
    const { unmount } = render(<Harness initial={['Gone']} options={[]} />);
    expect(screen.getByRole('checkbox', { name: 'Gone (no outlets now)' })).toBeInTheDocument();
    unmount();
    render(<Harness initial={['Gone']} options={[]} staleSuffix="" />);
    expect(screen.getByRole('checkbox', { name: 'Gone' })).toBeInTheDocument();
  });

  it('empty list text, hint wired via aria-describedby, and disabled', () => {
    render(<ScopeMultiSelect label="Sub-Programs" options={[]} values={[]} onChange={vi.fn()} emptyText="No sub-programs yet." hint="Leave empty for all." disabled />);
    expect(screen.getByText('No sub-programs yet.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Sub-Programs' });
    expect(group).toHaveAccessibleDescription('Leave empty for all.');
    expect(group).toBeDisabled();
  });
});

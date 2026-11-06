/// <reference types="vitest/globals" />
/**
 * OrderStepper — presentational only (steps are hand-built here, independent of the builder).
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OrderStepper } from '../order-stepper';
import type { OrderStep } from '@/lib/order-timeline';
import { formatDateTime } from '@/lib/utils';

const D1 = '2026-05-01T01:00:00.000Z';
const STEPS: OrderStep[] = [
  { key: 'placed', label: 'Order placed', state: 'complete', date: '2026-05-01T00:00:00.000Z' },
  { key: 'confirmed', label: 'Confirmed', state: 'complete', date: D1 },
  { key: 'processing', label: 'Processing', state: 'complete' },
  { key: 'dispatched', label: 'Dispatched', state: 'current', sublabel: 'Tracking: TN1' },
  { key: 'delivered', label: 'Delivered', state: 'upcoming' },
];
const FAILED_STEPS: OrderStep[] = [
  { key: 'placed', label: 'Order placed', state: 'complete' },
  { key: 'confirmed', label: 'Confirmed', state: 'complete' },
  { key: 'cancelled', label: 'Cancelled', state: 'failed', sublabel: 'Points refunded to your wallet' },
];

describe('OrderStepper — detail', () => {
  it('renders an <ol> with one <li> per step, in order, carrying its state', () => {
    render(<OrderStepper steps={STEPS} variant="detail" />);
    const list = screen.getByTestId('order-stepper-detail');
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual(STEPS.map((s) => `order-step-${s.key}`));
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(STEPS.map((s) => s.state));
  });

  it('marks ONLY the current step with aria-current="step"', () => {
    render(<OrderStepper steps={STEPS} variant="detail" />);
    expect(screen.getByTestId('order-step-dispatched')).toHaveAttribute('aria-current', 'step');
    for (const k of ['placed', 'confirmed', 'processing', 'delivered']) {
      expect(screen.getByTestId(`order-step-${k}`)).not.toHaveAttribute('aria-current');
    }
  });

  it('shows the formatted date for a dated step and NO date element for an undated one', () => {
    render(<OrderStepper steps={STEPS} variant="detail" />);
    expect(screen.getByTestId('order-step-date-confirmed')).toHaveTextContent(formatDateTime(D1));
    expect(screen.queryByTestId('order-step-date-processing')).toBeNull();
    expect(screen.queryByTestId('order-step-date-delivered')).toBeNull();
  });

  it('renders labels and sublabels', () => {
    render(<OrderStepper steps={FAILED_STEPS} variant="detail" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Points refunded to your wallet')).toBeInTheDocument();
    expect(screen.getByTestId('order-step-cancelled')).toHaveAttribute('data-state', 'failed');
  });
});

describe('OrderStepper — detail a11y (review)', () => {
  it('announces each step state as screen-reader text', () => {
    render(<OrderStepper steps={[...STEPS.slice(0, 4), STEPS[4]]} variant="detail" />);
    expect(within(screen.getByTestId('order-step-placed')).getByText('(completed)')).toHaveClass('sr-only');
    expect(within(screen.getByTestId('order-step-dispatched')).getByText('(current)')).toHaveClass('sr-only');
    expect(within(screen.getByTestId('order-step-delivered')).getByText('(upcoming)')).toHaveClass('sr-only');
    render(<OrderStepper steps={FAILED_STEPS} variant="detail" />);
    expect(within(screen.getByTestId('order-step-cancelled')).getByText('(failed)')).toHaveClass('sr-only');
  });
});

describe('OrderStepper — connectors (review)', () => {
  it('the connector INTO a failed step is not green (complete) — it uses the failed colour', () => {
    const { unmount } = render(<OrderStepper steps={FAILED_STEPS} variant="compact" />);
    const into = screen.getByTestId('order-compact-connector-confirmed');
    expect(into).toHaveAttribute('data-tone', 'failed');
    expect(into).not.toHaveClass('bg-emerald-400');
    unmount();
    render(<OrderStepper steps={STEPS} variant="compact" />);
    expect(screen.getByTestId('order-compact-connector-placed')).toHaveAttribute('data-tone', 'complete');
    expect(screen.getByTestId('order-compact-connector-dispatched')).toHaveAttribute('data-tone', 'upcoming');
  });
});

describe('OrderStepper — compact', () => {
  it('renders the compact bar with no dates and an aria-label "<label> — <state>" per dot', () => {
    render(<OrderStepper steps={STEPS} variant="compact" />);
    const bar = screen.getByTestId('order-stepper-compact');
    expect(bar.tagName).toBe('OL');
    expect(screen.getByLabelText('Dispatched — current')).toBeInTheDocument();
    expect(screen.getByLabelText('Order placed — complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Delivered — upcoming')).toBeInTheDocument();
    expect(screen.queryByTestId(/order-step-date-/)).toBeNull();
    expect(bar.textContent).not.toMatch(/\d{2}[-/]\d{2}/); // no date text at all
  });

  it('carries each step state for tests/a11y and marks the current dot', () => {
    render(<OrderStepper steps={STEPS} variant="compact" />);
    const dot = screen.getByTestId('order-compact-step-dispatched');
    expect(dot).toHaveAttribute('data-state', 'current');
    expect(dot).toHaveAttribute('aria-current', 'step');
  });

  it('captions the next upcoming step, and nothing once no step is upcoming', () => {
    const { unmount } = render(<OrderStepper steps={STEPS} variant="compact" />);
    expect(screen.getByTestId('order-stepper-next')).toHaveTextContent('Next: Delivered');
    unmount();
    render(<OrderStepper steps={FAILED_STEPS} variant="compact" />);
    expect(screen.queryByTestId('order-stepper-next')).toBeNull();
    // The failed dot is labelled for screen readers only (the card's status badge shows it visibly).
    expect(screen.getByLabelText('Cancelled — failed')).toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
});

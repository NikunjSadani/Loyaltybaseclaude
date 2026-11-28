/// <reference types="vitest/globals" />
/**
 * useUnsavedChangesGuard — while dirty: beforeunload prompt, in-app link clicks confirm, Back confirm;
 * all listeners gone once clean / unmounted.
 * Run: npx vitest run src/lib/__tests__/use-unsaved-changes-guard.test.tsx
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useUnsavedChangesGuard } from '../use-unsaved-changes-guard';

const MSG = 'You have unsaved notification changes — leave without saving?';

function Harness({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty, MSG);
  return (
    <div>
      <a href="/gifsy/clients" data-testid="internal">Clients</a>
      <a href="https://example.com/x" data-testid="external">Ext</a>
      <a href="#fund" data-testid="hash">Fund</a>
      <a href="/gifsy/users" target="_blank" data-testid="blank">Users</a>
    </div>
  );
}

/** Click an anchor; report whether the navigation was cancelled (defaultPrevented). */
function click(el: Element, init: MouseEventInit = {}) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}
const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confirmSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let backSpy: any;
beforeEach(() => {
  confirmSpy = vi.spyOn(window, 'confirm');
  backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useUnsavedChangesGuard', () => {
  it('clean: nothing is intercepted and no prompt is shown', () => {
    const { getByTestId } = render(<Harness dirty={false} />);
    expect(click(getByTestId('internal'))).toBe(false);
    expect(unload()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('dirty: an internal link asks; Cancel stops the navigation, OK lets it through', () => {
    const { getByTestId } = render(<Harness dirty />);
    confirmSpy.mockReturnValueOnce(false);
    expect(click(getByTestId('internal'))).toBe(true);
    expect(confirmSpy).toHaveBeenLastCalledWith(MSG);
    confirmSpy.mockReturnValueOnce(true);
    expect(click(getByTestId('internal'))).toBe(false);
  });

  it('dirty: external, #hash, target=_blank and modifier clicks are not intercepted', () => {
    const { getByTestId } = render(<Harness dirty />);
    expect(click(getByTestId('external'))).toBe(false);
    expect(click(getByTestId('hash'))).toBe(false);
    expect(click(getByTestId('blank'))).toBe(false);
    expect(click(getByTestId('internal'), { ctrlKey: true })).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('dirty: beforeunload is prevented (browser prompt)', () => {
    render(<Harness dirty />);
    expect(unload()).toBe(true);
  });

  it('dirty: a guard history entry is pushed; Back → Cancel re-arms it, OK really goes back', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    render(<Harness dirty />);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect((pushSpy.mock.calls[0][0] as Record<string, unknown>).__unsavedGuard).toBe(true);

    confirmSpy.mockReturnValueOnce(false);
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
    expect(confirmSpy).toHaveBeenLastCalledWith(MSG);
    expect(pushSpy).toHaveBeenCalledTimes(2); // re-armed, stayed
    expect(backSpy).not.toHaveBeenCalled();

    confirmSpy.mockReturnValueOnce(true);
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
    expect(backSpy).toHaveBeenCalledTimes(1); // left
  });

  it('becoming clean removes every listener (no prompt on link / Back / unload afterwards)', () => {
    const { getByTestId, rerender } = render(<Harness dirty />);
    rerender(<Harness dirty={false} />);
    expect(click(getByTestId('internal'))).toBe(false);
    expect(unload()).toBe(false);
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('unmounting removes every listener', () => {
    const { unmount } = render(<Harness dirty />);
    unmount();
    const a = document.createElement('a');
    a.href = '/gifsy/clients';
    document.body.appendChild(a);
    expect(click(a)).toBe(false);
    expect(unload()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    a.remove();
  });
});

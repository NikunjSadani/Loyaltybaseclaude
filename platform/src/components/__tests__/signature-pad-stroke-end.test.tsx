/** SIG-2: the shared SignaturePad reports "inked" when a stroke ENDS — never mid-stroke (a parent
 *  re-render then could remove rows below the pad and make it jump under the finger). */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignaturePad } from '../signature-pad';

const origGetContext = HTMLCanvasElement.prototype.getContext;
const ctxStub = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(),
  lineWidth: 0, lineCap: '', strokeStyle: '' };
beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxStub) as any;
});
afterEach(() => { HTMLCanvasElement.prototype.getContext = origGetContext; });

describe('SignaturePad — inked on stroke end (SIG-2)', () => {
  it('does not report inked mid-stroke; reports it once the stroke ends', () => {
    const onInked = vi.fn();
    const { container } = render(<SignaturePad onInkedChange={onInked} ariaLabel="pad" placeholder="sign" />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 50, clientY: 10 }] });
    expect(ctxStub.stroke).toHaveBeenCalledTimes(2);
    expect(onInked).not.toHaveBeenCalled();
    fireEvent.touchEnd(canvas);
    expect(onInked).toHaveBeenCalledWith(true);
    expect(onInked).toHaveBeenCalledTimes(1);
  });

  it('a tap without movement is not a signature', () => {
    const onInked = vi.fn();
    const { container } = render(<SignaturePad onInkedChange={onInked} ariaLabel="pad" placeholder="sign" />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
    fireEvent.mouseUp(canvas);
    expect(onInked).not.toHaveBeenCalled();
  });

  it('touchcancel ends a stroke that drew ink', () => {
    const onInked = vi.fn();
    const { container } = render(<SignaturePad onInkedChange={onInked} ariaLabel="pad" placeholder="sign" />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchCancel(canvas);
    expect(onInked).toHaveBeenCalledWith(true);
  });

  it('fires onStrokeStart once per stroke and ignores a second finger mid-stroke', () => {
    const onInked = vi.fn();
    const onStrokeStart = vi.fn();
    const { container } = render(<SignaturePad onInkedChange={onInked} onStrokeStart={onStrokeStart} ariaLabel="pad" placeholder="sign" />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.touchStart(canvas, { touches: [{ clientX: 5, clientY: 5 }] });
    fireEvent.touchMove(canvas, { touches: [{ clientX: 30, clientY: 30 }] });
    fireEvent.touchStart(canvas, { touches: [{ clientX: 30, clientY: 30 }, { clientX: 90, clientY: 40 }] });
    fireEvent.touchEnd(canvas);
    expect(onStrokeStart).toHaveBeenCalledTimes(1);
    expect(onInked).toHaveBeenCalledWith(true);
  });

  it('a second stroke after inking does not re-report', () => {
    const onInked = vi.fn();
    const { container } = render(<SignaturePad onInkedChange={onInked} ariaLabel="pad" placeholder="sign" />);
    const canvas = container.querySelector('canvas')!;
    for (let i = 0; i < 2; i++) {
      fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
      fireEvent.mouseMove(canvas, { clientX: 30, clientY: 30 });
      fireEvent.mouseUp(canvas);
    }
    expect(onInked).toHaveBeenCalledTimes(1);
  });
});

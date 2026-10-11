import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionGate, type SelectionGate } from './selectionGate';

let gate: SelectionGate | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  gate?.dispose();
  gate = null;
  vi.useRealTimers();
});

const pointer = (type: string, init: { button?: number; buttons?: number } = {}): void => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { button: init.button ?? 0, buttons: init.buttons ?? 0 });
  document.dispatchEvent(event);
};

describe('createSelectionGate', () => {
  it('evaluates once, after the pause, however many changes arrive', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    gate.notify();
    gate.notify();
    vi.advanceTimersByTime(79);
    expect(evaluate).not.toHaveBeenCalled();
    gate.notify(); // restarts the pause
    vi.advanceTimersByTime(79);
    expect(evaluate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('does not evaluate while the button is down, however long the drag takes', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    pointer('pointerdown');
    for (let i = 0; i < 10; i++) {
      gate.notify();
      vi.advanceTimersByTime(200);
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('evaluates once, shortly after the button is released', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    pointer('pointerdown');
    gate.notify();
    vi.advanceTimersByTime(500);
    pointer('pointerup');
    expect(evaluate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('a cancelled pointer, or a window that lost focus, releases the hold', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    pointer('pointerdown');
    pointer('pointercancel');
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);

    pointer('pointerdown');
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('a pointer that moves with no button held means the release was missed', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    pointer('pointerdown');
    pointer('pointermove', { buttons: 1 });
    vi.advanceTimersByTime(300);
    expect(evaluate).not.toHaveBeenCalled();
    pointer('pointermove', { buttons: 0 });
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('only the primary button holds the evaluation back', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate, 80);
    pointer('pointerdown', { button: 2 }); // context menu
    gate.notify();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('stops listening and cancels a pending evaluation when disposed', () => {
    const evaluate = vi.fn();
    const g = createSelectionGate(document, evaluate, 80);
    g.notify();
    g.dispose();
    vi.advanceTimersByTime(500);
    expect(evaluate).not.toHaveBeenCalled();
    pointer('pointerdown');
    pointer('pointerup');
    vi.advanceTimersByTime(500);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

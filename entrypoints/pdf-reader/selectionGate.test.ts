import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_ATTRIBUTE, createSelectionGate, type SelectionGate } from './selectionGate';

let gate: SelectionGate | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  gate?.dispose();
  gate = null;
  document.body.replaceChildren();
  document.documentElement.removeAttribute(DRAG_ATTRIBUTE);
  vi.useRealTimers();
});

/** Dispatch a pointer or mouse event the way the browser reports it (button, buttons bitmask). */
const fire = (
  type: string,
  init: { button?: number; buttons?: number } = {},
  target: EventTarget = document,
): void => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { button: init.button ?? 0, buttons: init.buttons ?? 0 });
  target.dispatchEvent(event);
};
const press = (): void => {
  fire('pointerdown', { button: 0, buttons: 1 });
  fire('mousedown', { button: 0, buttons: 1 });
};
const lift = (): void => {
  fire('pointerup', { button: 0, buttons: 0 });
  fire('mouseup', { button: 0, buttons: 0 });
};

describe('without a button held', () => {
  it('evaluates once, after the pause, however many changes arrive', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    gate.notify();
    gate.notify();
    vi.advanceTimersByTime(79);
    expect(evaluate).not.toHaveBeenCalled();
    gate.notify(); // restarts the pause
    vi.advanceTimersByTime(79);
    expect(evaluate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('a click that changes nothing evaluates after the pause and never holds anything back', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    lift();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
    gate.notify();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('a drag', () => {
  it('is not evaluated while the button is down, however long it goes on', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    for (let i = 0; i < 100; i++) {
      fire('pointermove', { buttons: 1 });
      gate.notify();
      vi.advanceTimersByTime(50); // 5 seconds of steady dragging
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('is evaluated once, shortly after the button is released', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    gate.notify();
    vi.advanceTimersByTime(500);
    lift();
    expect(evaluate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('cancels an evaluation that was already waiting when the button went down', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    gate.notify();
    vi.advanceTimersByTime(40);
    press();
    vi.advanceTimersByTime(200);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('works with mouse events alone (no pointer events) and with moves that show the button', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    fire('mousedown', { button: 0, buttons: 1 });
    gate.notify();
    vi.advanceTimersByTime(300);
    expect(evaluate).not.toHaveBeenCalled();
    fire('mouseup', { button: 0, buttons: 0 });
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);

    // The press itself was missed, but a move shows the button is down.
    fire('pointermove', { buttons: 1 });
    gate.notify();
    vi.advanceTimersByTime(300);
    expect(evaluate).toHaveBeenCalledTimes(1);
    lift();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('signals that are not a release', () => {
  it('a move reporting no button, and a window blur, do not end a drag', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    // Browsers dispatch such moves after a layout change or an auto-scroll under a held button.
    fire('pointermove', { buttons: 0 });
    fire('mousemove', { buttons: 0 });
    window.dispatchEvent(new Event('blur'));
    gate.notify();
    vi.advanceTimersByTime(400);
    expect(evaluate).not.toHaveBeenCalled();
    lift();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("another button's release (a context menu) does not end a drag", () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    fire('pointerup', { button: 2, buttons: 1 });
    fire('mouseup', { button: 2, buttons: 1 });
    gate.notify();
    vi.advanceTimersByTime(400);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a right-button press is not a drag', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    fire('pointerdown', { button: 2, buttons: 2 });
    gate.notify();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('a release that is never seen', () => {
  it('cannot hold the selection back for more than the safety valve', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    gate.notify();
    vi.advanceTimersByTime(1499);
    expect(evaluate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('evaluates a still selection once per quiet spell, not once per tick', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    gate.notify();
    vi.advanceTimersByTime(10_000);
    expect(evaluate).toHaveBeenCalledTimes(1);
    gate.notify(); // the selection changed again: a new quiet spell
    vi.advanceTimersByTime(1500);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('the next press and release puts things right', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press(); // the matching release never arrives
    vi.advanceTimersByTime(2000);
    evaluate.mockClear();
    press();
    lift();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);
    gate.notify();
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('a cancelled pointer and an ended native drag are releases', () => {
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    press();
    fire('pointercancel', { button: -1, buttons: 0 });
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(1);

    press();
    fire('dragend', { button: 0, buttons: 0 });
    vi.advanceTimersByTime(80);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('dispose', () => {
  it('stops listening and cancels what is pending', () => {
    const evaluate = vi.fn();
    const g = createSelectionGate(document, evaluate);
    g.notify();
    press();
    g.dispose();
    vi.advanceTimersByTime(5000);
    expect(evaluate).not.toHaveBeenCalled();
    press();
    lift();
    vi.advanceTimersByTime(5000);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('the drag mark (the save bar lets the pointer through during a drag)', () => {
  const marked = (): boolean => document.documentElement.hasAttribute(DRAG_ATTRIBUTE);
  function surfaces() {
    const text = document.createElement('div');
    text.className = 'sv-textlayer';
    const word = document.createElement('span');
    text.append(word);
    const bar = document.createElement('div');
    bar.className = 'sv-savebar';
    const button = document.createElement('button');
    bar.append(button);
    document.body.append(text, bar);
    return { word, button };
  }

  it('is set by a press in the text of a page and removed when the button is released', () => {
    const { word } = surfaces();
    gate = createSelectionGate(document, vi.fn());
    fire('pointerdown', { button: 0, buttons: 1 }, word);
    expect(marked()).toBe(true);
    fire('pointermove', { buttons: 1 }, word);
    expect(marked()).toBe(true);
    fire('pointerup', { button: 0, buttons: 0 }, word);
    expect(marked()).toBe(false);
  });

  it('is never set by a press on the bar itself, so its own click still lands', () => {
    const { button } = surfaces();
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    fire('pointerdown', { button: 0, buttons: 1 }, button);
    fire('mousedown', { button: 0, buttons: 1 }, button);
    fire('pointermove', { buttons: 1 }, button);
    expect(marked()).toBe(false);
    fire('pointerup', { button: 0, buttons: 0 }, button);
    expect(marked()).toBe(false);
  });

  it('is removed when the hold has been quiet for the safety valve, and comes back with activity', () => {
    const { word } = surfaces();
    const evaluate = vi.fn();
    gate = createSelectionGate(document, evaluate);
    fire('pointerdown', { button: 0, buttons: 1 }, word);
    expect(marked()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(marked()).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1);
    fire('pointermove', { buttons: 1 }, word);
    expect(marked()).toBe(true);
  });

  it('is removed when the gate is disposed', () => {
    const { word } = surfaces();
    const g = createSelectionGate(document, vi.fn());
    fire('pointerdown', { button: 0, buttons: 1 }, word);
    expect(marked()).toBe(true);
    g.dispose();
    expect(marked()).toBe(false);
  });
});

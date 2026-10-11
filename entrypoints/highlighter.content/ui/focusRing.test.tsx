import { act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { STYLES_CSS, declsFor, parseCss, readCss } from './testCss';
import { cleanupUi, focusToolbar, makeHighlight, mountUi, rect } from './testHarness';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

/** `.sv-root :focus` draws the ring, so a control outside .sv-root would have none. */
const RING_SCOPE = '.sv-root';

afterEach(cleanupUi);

function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

describe('every focusable control of the overlay is under the focus-ring rule', () => {
  it('the rule exists and draws a solid outline', () => {
    const ring = declsFor(parseCss(readCss(STYLES_CSS)), `${RING_SCOPE} :focus`);
    expect(ring.get('outline')).toContain('solid');
  });

  it('toolbar, More options panel, popover and toast actions', async () => {
    const m = mountUi();
    const user = userEvent.setup();
    act(() => m.ui.showToolbar({ text: 'abc', rect: rect(100, 200, 50, 20) }));
    await user.click(m.q.getByRole('button', { name: 'More options' }));
    await within(m.q.getByRole('dialog')).findByRole('combobox', { name: 'Bank' });
    act(() =>
      m.ui.toast({
        text: 'Saved',
        tone: 'success',
        action: { label: 'Undo', run: () => undefined },
      }),
    );
    act(() => m.ui.showHighlightPopover(makeHighlight(), rect(100, 300, 120, 20)));

    const found = focusables(m.container);
    // Toolbar (10) + panel (6) + popover (6) + toast (2): a floor, so a refactor cannot hide
    // controls from this check.
    expect(found.length).toBeGreaterThanOrEqual(22);
    const outside = found.filter((el) => !el.closest(RING_SCOPE));
    expect(outside.map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
  });

  it('focusToolbar lands on a button that the ring rule covers', () => {
    const m = mountUi();
    act(() => m.ui.showToolbar({ text: 'abc', rect: rect(100, 200, 50, 20) }));
    expect(focusToolbar(m.ui)).toBe(true);
    const focused = m.shadow.activeElement as HTMLElement;
    expect(focused.getAttribute('aria-label')).toBe('Save selection');
    expect(focused.closest(RING_SCOPE)).not.toBeNull();
  });

  it('focusToolbar onto a toast action lands on a button that the ring rule covers', () => {
    const m = mountUi();
    act(() =>
      m.ui.toast({
        text: 'Saved',
        tone: 'success',
        action: { label: 'Undo', run: () => undefined },
      }),
    );
    expect(focusToolbar(m.ui)).toBe(true);
    const focused = m.shadow.activeElement as HTMLElement;
    expect(focused.textContent).toBe('Undo');
    expect(focused.closest(RING_SCOPE)).not.toBeNull();
  });
});

/** Small DOM helpers for scripted gallery states (states where no address leads). */

/** Polls until `find` returns something truthy; throws a readable error after `timeout` ms. */
export async function waitFor<T>(
  find: () => T | null | undefined | false,
  what: string,
  timeout = 20_000,
): Promise<T> {
  const until = performance.now() + timeout;
  for (;;) {
    const found = find();
    if (found) return found;
    if (performance.now() > until) throw new Error(`Gallery state: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const $ = <E extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): E | null => root.querySelector<E>(selector);

/** The first `selector` element whose text contains `text`, innermost (not a wrapper around it). */
export function byText(
  text: string,
  selector = 'button',
  root: ParentNode = document,
): HTMLElement | null {
  const hits = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) =>
    el.textContent?.includes(text),
  );
  return hits.find((el) => !hits.some((other) => other !== el && el.contains(other))) ?? null;
}

/** Waits for the element to exist and be enabled (data may still be loading), then clicks it. */
export async function click(find: () => HTMLElement | null, what: string): Promise<void> {
  const ready = () => {
    const el = find();
    return el && !el.matches('[aria-disabled="true"], :disabled') ? el : null;
  };
  (await waitFor(ready, `${what} (enabled)`)).click();
}

export const clickTestId = (id: string) =>
  click(() => $(`[data-testid="${id}"]`), `[data-testid="${id}"]`);
export const clickText = (text: string, selector = 'button') =>
  click(() => byText(text, selector), `"${text}"`);

/** Sets a React-controlled input, textarea or select the way typing or choosing does. */
export function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement
        : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Two frames: React has committed and the browser has laid the result out. */
export const frames = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

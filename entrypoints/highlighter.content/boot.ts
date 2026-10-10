import type { ContentScriptContext } from 'wxt/utils/content-script-context';

/**
 * The same bundle can run twice in one isolated world (activeTab injection + registered script).
 * WXT already invalidates the older context when a newer one starts, but that handshake must not be
 * the only thing keeping a second controller (and a second toolbar) out of the page.
 */
const KEY = '__studyvaultContent';

export type BootContext = Pick<ContentScriptContext, 'isValid' | 'onInvalidated'>;

export interface Destroyable {
  destroy(): void;
}

interface Slot {
  ctx: BootContext;
  controller: Destroyable;
}

/**
 * Starts `start()` unless a controller with a still-valid context already runs in `world`.
 * A controller whose context is invalid (extension reloaded, superseded) is torn down and replaced.
 * Returns the new controller, or null when this execution was a no-op.
 */
export function bootOnce<T extends Destroyable>(
  world: object,
  ctx: BootContext,
  start: () => T,
): T | null {
  const slots = world as Record<string, Slot | undefined>;
  const existing = slots[KEY];
  if (existing) {
    if (existing.ctx.isValid) return null;
    delete slots[KEY];
    existing.controller.destroy();
  }

  const controller = start();
  slots[KEY] = { ctx, controller };
  ctx.onInvalidated(() => {
    controller.destroy();
    if (slots[KEY]?.controller === controller) delete slots[KEY];
  });
  return controller;
}

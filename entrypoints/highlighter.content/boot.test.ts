import { describe, expect, it, vi } from 'vitest';
import { bootOnce } from './boot';
import { fakeCtx } from './testUtils';

const controller = () => ({ destroy: vi.fn() });

describe('bootOnce', () => {
  it('starts exactly one controller when the script runs twice with a valid context', () => {
    const world = {};
    const start = vi.fn(controller);
    const first = bootOnce(world, fakeCtx(), start);
    const second = bootOnce(world, fakeCtx(), start);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('replaces a controller whose context was invalidated without running its cleanup twice', () => {
    const world = {};
    const ctxA = fakeCtx();
    const a = controller();
    bootOnce(world, ctxA, () => a);
    ctxA.isValid = false; // invalid, but onInvalidated has not been delivered yet
    const b = controller();
    const result = bootOnce(world, fakeCtx(), () => b);
    expect(result).toBe(b);
    expect(a.destroy).toHaveBeenCalledTimes(1);
  });

  it('invalidation destroys the controller and frees the slot', () => {
    const world = {};
    const ctx = fakeCtx();
    const a = controller();
    bootOnce(world, ctx, () => a);
    ctx.invalidate();
    expect(a.destroy).toHaveBeenCalledTimes(1);

    const b = controller();
    expect(bootOnce(world, fakeCtx(), () => b)).toBe(b);
  });

  it('a stale invalidation never frees the slot of its successor', () => {
    const world = {};
    const ctxA = fakeCtx();
    const a = controller();
    bootOnce(world, ctxA, () => a);
    ctxA.isValid = false;
    const ctxB = fakeCtx();
    const b = controller();
    bootOnce(world, ctxB, () => b);

    // Late delivery of A's invalidation (WXT notifies after the newer script took over).
    ctxA.isValid = true;
    ctxA.invalidate();
    expect(bootOnce(world, fakeCtx(), controller)).toBeNull(); // B still owns the world
  });

  it('keeps the guard off the page-visible global namespace shape (single key)', () => {
    const world: Record<string, unknown> = {};
    bootOnce(world, fakeCtx(), controller);
    expect(Object.keys(world)).toEqual(['__studyvaultContent']);
  });
});

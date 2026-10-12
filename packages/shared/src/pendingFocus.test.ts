import { describe, expect, it } from 'vitest';
import { PENDING_FOCUS_MAX_AGE_MS, classifySearchRequest } from './pendingFocus';

describe('classifySearchRequest', () => {
  const now = 1_000_000;
  it('acts on a fresh request addressed to this surface', () => {
    expect(classifySearchRequest({ target: 'panel', at: now - 50 }, now, 'panel')).toBe('mine');
    expect(classifySearchRequest({ target: 'dashboard', at: now }, now, 'dashboard')).toBe('mine');
  });

  it('leaves a request for the other surface alone', () => {
    expect(classifySearchRequest({ target: 'dashboard', at: now }, now, 'panel')).toBe('other');
    expect(classifySearchRequest({ target: 'panel', at: now }, now, 'dashboard')).toBe('other');
  });

  it('drops a stale or malformed request', () => {
    const old = now - PENDING_FOCUS_MAX_AGE_MS - 1;
    expect(classifySearchRequest({ target: 'panel', at: old }, now, 'panel')).toBe('drop');
    expect(classifySearchRequest({ target: 'nowhere', at: now }, now, 'panel')).toBe('drop');
    expect(classifySearchRequest('x', now, 'panel')).toBe('drop');
    expect(classifySearchRequest(null, now, 'panel')).toBe('drop');
  });

  it('keeps a request when the clock moved backwards rather than losing it', () => {
    expect(classifySearchRequest({ target: 'panel', at: now + 5_000 }, now, 'panel')).toBe('mine');
  });
});

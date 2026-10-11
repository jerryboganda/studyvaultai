import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_PREF_KEYS, LOCAL_PREF_PREFIX, clearLocalPrefs } from './localPrefs';

const ROOT = join(__dirname, '..', '..', '..');

/** `sv.`-prefixed names that are not `localStorage` keys, with where they really live. */
const NOT_LOCAL_STORAGE: Record<string, string> = {
  'sv.pendingFocus': 'chrome.storage.session (PENDING_FOCUS_KEY, packages/shared)',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the list of localStorage keys', () => {
  it('names every `sv.` string a source file writes, so "Delete all data" can remove it', () => {
    // The list's own file defines the keys; what must name them is everything else.
    const files = [
      ...sources(join(ROOT, 'entrypoints')),
      ...sources(join(ROOT, 'packages')),
    ].filter((file) => !file.endsWith('localPrefs.ts'));
    expect(files.length).toBeGreaterThan(100);
    const known = new Set<string>([
      ...Object.values(LOCAL_PREF_KEYS),
      ...Object.keys(NOT_LOCAL_STORAGE),
    ]);
    const unknown: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(['"`])(sv\.[^'"`\s]*)\1/g)) {
        const key = m[2]!;
        if (!known.has(key)) unknown.push(`${file.slice(ROOT.length)}: ${key}`);
      }
      for (const m of text.matchAll(/LOCAL_PREF_KEYS\.(\w+)/g)) used.add(m[1]!);
    }
    expect(
      unknown,
      'add the key to LOCAL_PREF_KEYS in packages/ui/src/localPrefs.ts (it is removed by Delete all data), or to NOT_LOCAL_STORAGE here when it is not localStorage',
    ).toEqual([]);
    // The list is not stale either: each entry is used by the product.
    for (const name of Object.keys(LOCAL_PREF_KEYS)) {
      expect(used.has(name), `LOCAL_PREF_KEYS.${name} is in the list but no source uses it`).toBe(
        true,
      );
    }
  });

  it('keeps every key under the prefix', () => {
    for (const key of Object.values(LOCAL_PREF_KEYS)) {
      expect(key.startsWith(LOCAL_PREF_PREFIX)).toBe(true);
    }
  });
});

describe('clearLocalPrefs', () => {
  beforeEach(() => window.localStorage.clear());

  it('removes the listed keys and any other `sv.` key, and nothing else', () => {
    for (const key of Object.values(LOCAL_PREF_KEYS)) window.localStorage.setItem(key, 'x');
    window.localStorage.setItem('sv.from-an-older-build', 'x');
    window.localStorage.setItem('other.page.key', 'keep');

    const removed = clearLocalPrefs();

    expect(removed.sort()).toEqual(
      [...Object.values(LOCAL_PREF_KEYS), 'sv.from-an-older-build'].sort(),
    );
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem('other.page.key')).toBe('keep');
  });

  it('is a no-op on an empty store', () => {
    expect(clearLocalPrefs()).toEqual([]);
  });
});

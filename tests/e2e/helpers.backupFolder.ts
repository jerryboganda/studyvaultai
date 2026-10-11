import type { Page } from '@playwright/test';

/**
 * Helpers for backup-folder.spec.ts.
 *
 * Playwright cannot drive the browser's native folder picker, so `window.showDirectoryPicker` of the
 * extension page is replaced by a function that returns a directory of the extension origin's
 * private file system (OPFS, `navigator.storage.getDirectory()`). Everything after the picker is
 * the product's own code on a real FileSystemDirectoryHandle: the handle is stored in IndexedDB,
 * read back from it, written with createWritable, listed, read back and removed with removeEntry.
 * The one thing this cannot show is Chrome's permission prompt for a folder on a real disk; the
 * prompt is exercised by replacing `queryPermission` / `requestPermission` (see below).
 */

/** The OPFS directory the stubbed picker hands out: the stand-in for a folder on the person's disk. */
export const FOLDER = 'sv-e2e-backups';

/** The shape of the folder dependency's picker, as the page sees it. */
interface PickerWindow {
  showDirectoryPicker?: unknown;
  __svPickerCalls?: number;
}

/** Make the next "Choose a backup folder" return `FOLDER` (created when missing). */
export async function stubFolderPicker(page: Page, dir = FOLDER): Promise<void> {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const w = window as unknown as PickerWindow;
    w.__svPickerCalls = 0;
    w.showDirectoryPicker = async () => {
      w.__svPickerCalls = (w.__svPickerCalls ?? 0) + 1;
      return root.getDirectoryHandle(name, { create: true });
    };
  }, dir);
}

/** Names in the folder (sub-directories end in "/"), sorted; empty when the folder is not there. */
export async function folderNames(page: Page, dir = FOLDER): Promise<string[]> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await root.getDirectoryHandle(name);
    } catch {
      return [];
    }
    const entries = (
      handle as unknown as {
        entries(): AsyncIterable<[string, { kind: 'file' | 'directory' }]>;
      }
    ).entries();
    const out: string[] = [];
    for await (const [entry, info] of entries) {
      out.push(info.kind === 'directory' ? `${entry}/` : entry);
    }
    return out.sort();
  }, dir);
}

/** The file's bytes, exactly as on disk. */
export async function readFolderFile(page: Page, file: string, dir = FOLDER): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ dirName, file }) => {
      const root = await navigator.storage.getDirectory();
      const d = await root.getDirectoryHandle(dirName);
      const f = await (await d.getFileHandle(file)).getFile();
      return Array.from(new Uint8Array(await f.arrayBuffer()));
    },
    { dirName: dir, file },
  );
  return Buffer.from(bytes);
}

/** A file somebody else put in the folder (the folder is created when missing). */
export async function putFolderFile(
  page: Page,
  file: string,
  content: Uint8Array | string,
  dir = FOLDER,
): Promise<void> {
  const data = typeof content === 'string' ? Array.from(Buffer.from(content)) : Array.from(content);
  await page.evaluate(
    async ({ dirName, file, data }) => {
      const root = await navigator.storage.getDirectory();
      const d = await root.getDirectoryHandle(dirName, { create: true });
      const writable = await (await d.getFileHandle(file, { create: true })).createWritable();
      await writable.write(new Uint8Array(data));
      await writable.close();
    },
    { dirName: dir, file, data },
  );
}

/** A sub-directory (a "file" of that name cannot exist beside it). */
export async function putFolderDirectory(page: Page, name: string, dir = FOLDER): Promise<void> {
  await page.evaluate(
    async ({ dirName, name }) => {
      const root = await navigator.storage.getDirectory();
      const d = await root.getDirectoryHandle(dirName, { create: true });
      await d.getDirectoryHandle(name, { create: true });
    },
    { dirName: dir, name },
  );
}

/** The folder is deleted behind StudyVault's back (moved, drive unplugged). */
export async function removeFolder(page: Page, dir = FOLDER): Promise<void> {
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true });
  }, dir);
}

interface PermissionProto {
  queryPermission: () => Promise<string>;
  requestPermission: () => Promise<string>;
}

/**
 * What Chrome answers for a folder on a real disk after a restart: "ask me" and then the person's
 * choice. Replaces the methods on the shared prototype of every handle of this page (a reload
 * undoes it).
 */
export async function setFolderPermission(
  page: Page,
  query: 'granted' | 'prompt' | 'denied',
  afterRequest: 'granted' | 'denied',
): Promise<void> {
  await page.evaluate(
    ({ query, afterRequest }) => {
      const proto = FileSystemHandle.prototype as unknown as PermissionProto;
      proto.queryPermission = () => Promise.resolve(query);
      proto.requestPermission = () => Promise.resolve(afterRequest);
    },
    { query, afterRequest },
  );
}

/** Every write fails like a full drive does in Chrome (a reload undoes it). */
export async function makeDiskFull(page: Page): Promise<void> {
  await page.evaluate(() => {
    FileSystemWritableFileStream.prototype.write = () =>
      Promise.reject(
        new DOMException('No space available for this operation', 'QuotaExceededError'),
      );
  });
}

/** The page has no folder picker at all (a browser without the File System Access API). */
export async function withoutFolderPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });
}

/** The handle row of `meta`, reduced to what can cross the wire (it is a real directory handle). */
export async function storedHandle(
  page: Page,
): Promise<{ kind: string; name: string; isHandle: boolean } | null> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const row = await new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
        const req = db
          .transaction('meta', 'readonly')
          .objectStore('meta')
          .get('backupFolder.handle');
        req.onsuccess = () => resolve(req.result as { value?: unknown } | undefined);
        req.onerror = () => reject(req.error);
      });
      const value = row?.value;
      if (!value) return null;
      return {
        kind: String((value as { kind?: unknown }).kind),
        name: String((value as { name?: unknown }).name),
        isHandle:
          typeof FileSystemDirectoryHandle !== 'undefined' &&
          value instanceof FileSystemDirectoryHandle,
      };
    } finally {
      db.close();
    }
  });
}

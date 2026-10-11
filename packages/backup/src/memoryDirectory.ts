// Test helper only: not exported from index.ts and never imported by production code.
import type {
  FolderDirectory,
  FolderEntry,
  FolderFileHandle,
  FolderPermissionState,
  FolderWritable,
} from './folder';

/**
 * An in-memory directory with the behaviour of Chrome's FileSystemDirectoryHandle that matters
 * here: `getFileHandle({ create })` makes an empty file at once, a writable buffers and replaces
 * the file only on `close`, a full drive fails at `write` with QuotaExceededError, and a deleted
 * folder fails every call with NotFoundError. Faults are switched on through the public fields.
 */
export class MemoryDirectory implements FolderDirectory {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  /** What `queryPermission` answers, and what `requestPermission` turns it into. */
  permission: FolderPermissionState = 'granted';
  afterRequest: FolderPermissionState = 'granted';
  requests = 0;
  /** The folder was deleted or its drive removed. */
  gone = false;
  /** Bytes that still fit; a bigger write fails with QuotaExceededError. */
  freeBytes = Number.POSITIVE_INFINITY;
  /** What actually lands on disk on `close`: lets a test write a short or altered file. */
  corrupt: ((bytes: Uint8Array) => Uint8Array) | null = null;
  /** Names that cannot be removed (a locked file). */
  locked = new Set<string>();

  constructor(readonly name = 'StudyVault backups') {}

  private check(): void {
    if (this.gone)
      throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
    if (this.permission !== 'granted') {
      throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError');
    }
  }

  queryPermission(): Promise<FolderPermissionState> {
    return Promise.resolve(this.permission);
  }

  requestPermission(): Promise<FolderPermissionState> {
    this.requests++;
    this.permission = this.afterRequest;
    return Promise.resolve(this.permission);
  }

  /** Put a file in the folder as if the person (or another program) had. */
  put(name: string, bytes: Uint8Array | string): void {
    this.files.set(name, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FolderFileHandle> {
    try {
      this.check();
      if (this.directories.has(name)) {
        throw new DOMException(
          'The path supplied exists, but was not an entry of requested type.',
          'TypeMismatchError',
        );
      }
      if (!this.files.has(name)) {
        if (!options.create)
          throw new DOMException('A requested file could not be found.', 'NotFoundError');
        this.files.set(name, new Uint8Array(0));
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(this.handle(name));
  }

  private handle(name: string): FolderFileHandle {
    return {
      getFile: () => {
        try {
          this.check();
        } catch (err) {
          return Promise.reject(err);
        }
        const bytes = this.files.get(name);
        if (!bytes) return Promise.reject(new DOMException('gone', 'NotFoundError'));
        return Promise.resolve(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      },
      createWritable: (): Promise<FolderWritable> => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        return Promise.resolve({
          write: (data: Uint8Array) => {
            if (size + data.length > this.freeBytes) {
              return Promise.reject(
                new DOMException('No space available for this operation', 'QuotaExceededError'),
              );
            }
            chunks.push(data);
            size += data.length;
            return Promise.resolve();
          },
          close: () => {
            const all = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) {
              all.set(c, at);
              at += c.length;
            }
            this.files.set(name, this.corrupt ? this.corrupt(all) : all);
            return Promise.resolve();
          },
          abort: () => Promise.resolve(),
        });
      },
    };
  }

  removeEntry(name: string): Promise<void> {
    try {
      this.check();
      if (this.locked.has(name)) {
        throw new DOMException('The file is locked.', 'NoModificationAllowedError');
      }
      if (!this.files.delete(name) && !this.directories.delete(name)) {
        throw new DOMException('A requested file could not be found.', 'NotFoundError');
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve();
  }

  async *values(): AsyncGenerator<FolderEntry> {
    this.check();
    for (const name of [...this.files.keys()]) yield { kind: 'file', name };
    for (const name of [...this.directories]) yield { kind: 'directory', name };
  }

  /** Names of the files in the folder, sorted. */
  names(): string[] {
    return [...this.files.keys()].sort();
  }
}

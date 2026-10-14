import type { DBCoreTable, Dexie } from 'dexie';

/**
 * Gallery-only fault injection (`?fault=`), so the real pages show their own error and loading
 * states. A comma-separated list of `<target>:<mode>` rules:
 *  - target: an RPC message type (`site.status`, `content.pageStatus`, `sync.status`; `*` = every
 *    RPC), `chrome.<api>` for the fake Chrome API (`chrome.tabs.query`, `chrome.storage.local.set`),
 *    or `db.<table>[.<operation>[.<index>]]` for IndexedDB (`db.highlights`, `db.notes.query`,
 *    `db.notes.query.primary`, `db.*`; the operations are Dexie's DBCore get, getMany, query,
 *    openCursor, count and mutate; query, openCursor and count name the index they read, `primary`
 *    for the primary key). `*` matches any run of characters.
 *  - mode: `error` (a retryable failure), `unavailable` (storage_unavailable: IndexedDB broken),
 *    `slow` (answers after SLOW_MS; not for db.*: an IndexedDB transaction cannot wait) or `hang`
 *    (never answers).
 * Rules are armed just before the page mounts, so seeding is never affected, and paused while the
 * gallery switches the theme. Every hit is recorded in `window.__gallery.calls` as `fault`.
 */
export type FaultMode = 'error' | 'unavailable' | 'slow' | 'hang';
const MODES: readonly FaultMode[] = ['error', 'unavailable', 'slow', 'hang'];
export const SLOW_MS = 3000;

type Layer = 'rpc' | 'chrome' | 'db';
const layerOf = (name: string): Layer =>
  name.startsWith('chrome.') ? 'chrome' : name.startsWith('db.') ? 'db' : 'rpc';

interface Rule {
  layer: Layer;
  re: RegExp;
  mode: FaultMode;
}

let rules: Rule[] = [];
let armed = false;
let onHit: (name: string, mode: FaultMode) => void = () => undefined;

export function parseFaults(spec: string | null): Rule[] {
  if (!spec) return [];
  return spec
    .split(',')
    .filter(Boolean)
    .map((part) => {
      const at = part.lastIndexOf(':');
      const target = part.slice(0, at).trim();
      const mode = part.slice(at + 1).trim() as FaultMode;
      if (at <= 0 || !MODES.includes(mode)) {
        throw new Error(`Bad fault "${part}": use <target>:${MODES.join('|')}.`);
      }
      const layer = layerOf(target);
      if (layer === 'db' && mode === 'slow') {
        throw new Error(`Bad fault "${part}": db targets take error, unavailable or hang.`);
      }
      const pattern = target.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      // db names are `db.<table>.<operation>`: `db.notes` covers every operation on that table.
      const rest = layer === 'db' ? '(?:\\..+)?' : '';
      return { layer, re: new RegExp(`^${pattern}${rest}$`), mode };
    });
}

export function setFaults(spec: string | null, hit: typeof onHit): void {
  rules = parseFaults(spec);
  onHit = hit;
}

export function armFaults(on: boolean): void {
  armed = on;
}

/** Runs `work` with the faults paused (the gallery's own theme switch). */
export async function withoutFaults<T>(work: () => Promise<T>): Promise<T> {
  const was = armed;
  armed = false;
  try {
    return await work();
  } finally {
    armed = was;
  }
}

/** The mode of the first armed rule for `name` (an RPC type, `chrome.…` or `db.…`). */
export function faultFor(name: string): FaultMode | null {
  if (!armed) return null;
  const layer = layerOf(name);
  const mode = rules.find((r) => r.layer === layer && r.re.test(name))?.mode ?? null;
  if (mode) onHit(name, mode);
  return mode;
}

export const faultMessage = (name: string) => `Gallery fault injected: ${name}`;
export const never = () => new Promise<never>(() => undefined);
export const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `db.<table>` faults as Dexie DBCore middleware. Register before the database first opens. */
export function registerDbFaults(db: Dexie): void {
  if (db.isOpen()) throw new Error('Gallery faults must be registered before the database opens.');
  db.use({
    stack: 'dbcore',
    name: 'gallery-faults',
    create: (down) => ({
      ...down,
      table(tableName) {
        const table = down.table(tableName);
        const guard =
          <A, R>(name: string, op: (req: A) => Promise<R>) =>
          (req: A): Promise<R> => {
            const index = (req as { query?: { index?: { isPrimaryKey?: boolean; name?: string } } })
              .query?.index;
            const on = index ? `.${index.isPrimaryKey ? 'primary' : index.name}` : '';
            const target = `db.${tableName}.${name}${on}`;
            const mode = faultFor(target);
            if (mode === 'hang') return never();
            if (mode === 'error') {
              return Promise.reject(
                Object.assign(new Error(faultMessage(target)), { name: 'GalleryFault' }),
              );
            }
            // toStorageError maps UnknownError to storage_unavailable.
            if (mode === 'unavailable') {
              return Promise.reject(new DOMException(faultMessage(target), 'UnknownError'));
            }
            return op(req);
          };
        const wrapped: DBCoreTable = {
          ...table,
          get: guard('get', (r) => table.get(r)),
          getMany: guard('getMany', (r) => table.getMany(r)),
          query: guard('query', (r) => table.query(r)),
          openCursor: guard('openCursor', (r) => table.openCursor(r)),
          count: guard('count', (r) => table.count(r)),
          mutate: guard('mutate', (r) => table.mutate(r)),
        };
        return wrapped;
      },
    }),
  });
}

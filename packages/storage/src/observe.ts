import { liveQuery } from 'dexie';

export interface Observable<T> {
  /** Emits the query result now and again whenever any table it read changes. Returns unsubscribe. */
  subscribe(next: (value: T) => void, error?: (err: unknown) => void): () => void;
}

/**
 * Let UI code react to database changes without importing Dexie. `query` should call the repo
 * read functions only; they never write, which Dexie forbids inside a live query.
 */
export function observe<T>(query: () => Promise<T>): Observable<T> {
  return {
    subscribe(next, error) {
      const subscription = liveQuery(query).subscribe({ next, error });
      return () => subscription.unsubscribe();
    },
  };
}

import type { TableSpec } from '@shared';
import { keyString, rowKey } from './canonical';
import { BackupError, isBackupError } from './errors';
import type { Row, RowKey, RowReader, TableRead } from './types';

function isAsyncIterable(v: TableRead): v is AsyncIterable<readonly Row[]> {
  return typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

/**
 * Walk a whole table through `reader.readTable`, page by page, in primary-key order. Works with both
 * read styles (see TableRead). A source that does not advance fails loudly instead of looping.
 */
export async function* readAll(
  reader: RowReader,
  spec: Pick<TableSpec, 'name' | 'primaryKey'>,
  limit: number,
): AsyncGenerator<readonly Row[]> {
  let afterKey: RowKey | undefined;
  let lastKeyText: string | null = null;
  try {
    for (;;) {
      const res = reader.readTable(
        spec.name,
        afterKey === undefined ? { limit } : { afterKey, limit },
      );
      if (isAsyncIterable(res)) {
        for await (const page of res) if (page.length > 0) yield page;
        return;
      }
      const page = await res;
      if (page.length === 0) return;
      yield page;
      if (page.length < limit) return;
      afterKey = rowKey(spec, page[page.length - 1] as Row);
      const text = keyString(afterKey);
      if (text === lastKeyText) {
        throw new BackupError(
          'source_error',
          `readTable("${spec.name}") ignored afterKey and returned the same page again.`,
          { table: spec.name },
        );
      }
      lastKeyText = text;
    }
  } catch (cause) {
    if (isBackupError(cause)) throw cause;
    throw new BackupError(
      'source_error',
      `Reading table "${spec.name}" failed.`,
      { table: spec.name },
      cause,
    );
  }
}

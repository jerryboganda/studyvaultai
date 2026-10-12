import type { ExportProgress } from '@backup';
import { tableLabel } from './format';

const PHASE: Record<ExportProgress['phase'], string> = {
  reading: 'Reading',
  compressing: 'Compressing',
  encrypting: 'Encrypting',
  done: 'Finishing',
};

/** Real progress of a running export: the engine's own row counts, never a fake bar. */
export function ExportProgressView({
  progress,
  testId,
}: {
  progress: ExportProgress | null;
  testId: string;
}) {
  return (
    <div className="sv-stack sv-stack--tight" role="status" data-testid={testId}>
      <progress
        aria-label="Backup progress"
        className="bk-progress"
        {...(progress && progress.rowsTotal > 0
          ? { value: progress.rowsDone, max: progress.rowsTotal }
          : {})}
      />
      <p className="sv-small">
        {progress
          ? `${PHASE[progress.phase]}${
              progress.table ? ` ${tableLabel(progress.table).toLowerCase()}` : ''
            }… ${progress.rowsDone} of ${progress.rowsTotal} items`
          : 'Starting…'}
      </p>
    </div>
  );
}

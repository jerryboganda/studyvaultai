import type { ExportProgress } from '@backup';
import { BarMeter } from '../design/BarMeter';
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
  const text = progress
    ? `${PHASE[progress.phase]}${
        progress.table ? ` ${tableLabel(progress.table).toLowerCase()}` : ''
      }… ${progress.rowsDone} of ${progress.rowsTotal} items`
    : 'Starting…';
  return (
    <div className="sd-progress" data-testid={testId}>
      {/* Empty until the engine reports its first counts: no movement that is not real. */}
      <BarMeter
        value={progress?.rowsDone ?? 0}
        max={progress && progress.rowsTotal > 0 ? progress.rowsTotal : 1}
        label="Backup progress"
        valueText={text}
        size="lg"
      />
      <p className="sd-progress__line" role="status">
        {text}
      </p>
    </div>
  );
}

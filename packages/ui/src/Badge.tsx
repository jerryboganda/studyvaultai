import type { CSSProperties, ReactNode } from 'react';
import {
  COLOR_SWATCH,
  KIND_LABELS,
  type ColorId,
  type HighlightKind,
  type ResolveStatus,
} from '@shared';
import { describeResolveState } from './resolveState';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Small label. The glyph is decorative; the text must always say the same thing as the colour. */
export function Badge({
  tone = 'neutral',
  glyph,
  children,
}: {
  tone?: Tone;
  glyph?: string;
  children: ReactNode;
}) {
  return (
    <span className={`sv-badge sv-badge--${tone}`}>
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      <span>{children}</span>
    </span>
  );
}

/** Highlight kind: glyph + label, with the highlight colour as an accent edge only. */
export function KindChip({ kind, color }: { kind: HighlightKind; color: ColorId }) {
  const { label, glyph } = KIND_LABELS[kind];
  const style = { '--sv-chip': COLOR_SWATCH[color].solid } as CSSProperties;
  return (
    <span className="sv-badge sv-chip" style={style}>
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  );
}

export function ResolveBadge({ status }: { status: ResolveStatus }) {
  const d = describeResolveState(status);
  return (
    <Badge tone={d.tone} glyph={d.glyph}>
      {d.label}
    </Badge>
  );
}

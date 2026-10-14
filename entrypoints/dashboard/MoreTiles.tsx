import {
  Archive,
  ArrowLeft,
  BookOpen,
  ChartColumn,
  Copy,
  FileInput,
  HardDrive,
  Layers,
  ListTree,
  MessagesSquare,
  Network,
  RefreshCw,
  Sparkles,
  Timer,
  Trash,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Settings } from '@shared';
import type { ArtTone } from '@ui';
import { reviewSearch, type ReviewView } from '@ui/review/links';
import { settingsPath, type SettingsSectionId } from '@ui/shell/paths';
import { extensionUrl } from './links';

/** The dashboard views that live under "More" (each has a `view-<id>` tile). */
export type MoreView = 'duplicates' | 'trash' | 'storage' | 'chat' | 'graph' | 'syllabus' | 'rules';

export const MORE_VIEW_LABELS: Record<MoreView, string> = {
  duplicates: 'Duplicate quotes',
  trash: 'Trash',
  storage: 'Storage',
  chat: 'Chat with your notes',
  graph: 'Knowledge graph',
  syllabus: 'Syllabus',
  rules: 'Filing rules',
};

interface TileBase {
  id: string;
  /** <= 2 words. */
  label: string;
  icon: LucideIcon;
  tone: ArtTone;
  /** "Off" for a feature that is switched off (the tile still opens its setup). */
  status?: string;
}
export type MoreTile = TileBase & ({ view: MoreView } | { href: string });

const review = (view: ReviewView) =>
  extensionUrl(`review.html${reviewSearch({ view }) ? `?${reviewSearch({ view })}` : ''}`);
const settings = (section: SettingsSectionId) => extensionUrl(settingsPath(section));

/** Everything outside the core tabs, most used first (UX_DESIGN 9). */
export function moreTiles(features: Settings['features'] | null): MoreTile[] {
  const off = (on: boolean | undefined) => (features && !on ? 'Off' : undefined);
  return [
    { id: 'exam', label: 'Exam', icon: Timer, tone: 'danger', href: review('exam') },
    { id: 'syllabus', label: 'Syllabus', icon: ListTree, tone: 'success', view: 'syllabus' },
    { id: 'cards', label: 'Cards', icon: Layers, tone: 'primary', href: review('cards') },
    { id: 'stats', label: 'Stats', icon: ChartColumn, tone: 'violet', href: review('analytics') },
    { id: 'rules', label: 'Rules', icon: Workflow, tone: 'primary', view: 'rules' },
    { id: 'imports', label: 'Imports', icon: FileInput, tone: 'primary', href: settings('backup') },
    { id: 'backup', label: 'Backup', icon: Archive, tone: 'success', href: settings('backup') },
    { id: 'duplicates', label: 'Duplicates', icon: Copy, tone: 'warning', view: 'duplicates' },
    { id: 'trash', label: 'Trash', icon: Trash, tone: 'danger', view: 'trash' },
    { id: 'graph', label: 'Graph', icon: Network, tone: 'violet', view: 'graph' },
    { id: 'storage', label: 'Storage', icon: HardDrive, tone: 'sun', view: 'storage' },
    {
      id: 'reader',
      label: 'PDF reader',
      icon: BookOpen,
      tone: 'warning',
      href: extensionUrl('pdf-reader.html'),
    },
    {
      id: 'ai',
      label: 'AI',
      icon: Sparkles,
      tone: 'violet',
      status: off(features?.ai),
      href: settings('ai'),
    },
    {
      id: 'chat',
      label: 'Chat',
      icon: MessagesSquare,
      tone: 'primary',
      status: off(features?.ai),
      view: 'chat',
    },
    {
      id: 'sync',
      label: 'Sync',
      icon: RefreshCw,
      tone: 'success',
      status: off(features?.sync),
      href: settings('sync'),
    },
  ];
}

/**
 * The More tiles: a dashboard view opens in place (`view-<id>` test ids, kept from the old nav),
 * another page opens in a new tab as a real link.
 */
export function MoreGridTiles({
  tiles,
  label,
  onView,
}: {
  tiles: readonly MoreTile[];
  label: string;
  onView(view: MoreView): void;
}) {
  return (
    <ul className="sv-moregrid dash-moregrid" aria-label={label}>
      {tiles.map((t) => {
        const Icon = t.icon;
        const inner = (
          <>
            <span className={`sv-moretile__icon sv-art--${t.tone}`} aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <span className="sv-moretile__label">{t.label}</span>
            {t.status ? (
              <span className="sv-moretile__status">
                <span className="sv-vh">, </span>
                {t.status}
              </span>
            ) : null}
          </>
        );
        return (
          <li key={t.id}>
            {'view' in t ? (
              <button
                type="button"
                className="sv-moretile"
                onClick={() => onView(t.view)}
                data-testid={`view-${t.view}`}
              >
                {inner}
              </button>
            ) : (
              <a
                className="sv-moretile"
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`more-${t.id}`}
              >
                {inner}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Back from a More view to the More grid. */
export function BackToMore({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="dash-back" onClick={onClick} data-testid="back-to-more">
      <ArrowLeft aria-hidden="true" strokeWidth={2.5} />
      More
    </button>
  );
}

import type { ReactNode } from 'react';

const GLYPH = { info: 'i', success: '✓', warning: '!', error: '✕' } as const;
const TONE_LABEL = { info: 'Note', success: 'Done', warning: 'Warning', error: 'Error' } as const;

/**
 * Inline message. Errors are announced immediately (role="alert"); other tones are static
 * content unless `live` is set for messages that appear after an action.
 */
export function InlineNotice({
  tone = 'info',
  title,
  live = false,
  action,
  children,
}: {
  tone?: keyof typeof GLYPH;
  title?: string;
  live?: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const role = tone === 'error' ? 'alert' : live ? 'status' : undefined;
  return (
    <div className={`sv-notice sv-notice--${tone}`} role={role}>
      <span className="sv-notice__glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <div className="sv-notice__body">
        <span className="sv-sr">{TONE_LABEL[tone]}: </span>
        {title ? <p className="sv-notice__title">{title}</p> : null}
        {children ? <div className="sv-notice__text">{children}</div> : null}
        {action ? <div className="sv-notice__action">{action}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="sv-empty">
      <p className="sv-empty__title">{title}</p>
      {children ? <div className="sv-empty__text">{children}</div> : null}
      {action ? <div className="sv-empty__action">{action}</div> : null}
    </div>
  );
}

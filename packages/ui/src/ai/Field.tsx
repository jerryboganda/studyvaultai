import { useId, type ReactNode } from 'react';

/** A labelled control with an optional hint wired to it (aria-describedby). */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="sv-field">
      <label className="sv-label" htmlFor={id}>
        {label}
      </label>
      {children(id, hintId)}
      {hint ? (
        <p id={hintId} className="sv-muted sv-small">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

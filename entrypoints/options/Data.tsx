import { useId } from 'react';
import { DeleteData } from './DeleteData';

/** "Your data": where it lives, how to take a copy, and the one irreversible control. */
export function YourData() {
  const uid = useId();
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Your data</h2>
      <p>
        Your highlights, notes, banks, flashcards and review history live in this Chrome profile
        only. To keep a copy or move to another computer, use{' '}
        <a href="#backup">Backup and restore</a>; to see what takes space, use{' '}
        <a href="#storage">Storage</a>.
      </p>
      <DeleteData />
    </section>
  );
}

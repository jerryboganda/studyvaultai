import { useId } from 'react';
import { browser } from 'wxt/browser';
import { MAX_CONTEXT_CHARS, MAX_HEADING_CHARS, MAX_QUOTE_CHARS, MAX_TITLE_CHARS } from '@shared';
import { PERMISSION_PURPOSES } from './model';

export function Privacy() {
  const uid = useId();
  const manifest = browser.runtime.getManifest();
  const permissions = manifest.permissions ?? [];
  // Asked for later, from a click, and only for the feature that needs them (never at install).
  const optional = manifest.optional_permissions ?? [];
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Privacy</h2>
      <p>
        <strong>Everything stays on this device by default.</strong> StudyVault has no account, no
        analytics and no server of its own, and it does not send your highlights, notes or browsing
        anywhere. Two optional features can send data, and only after you turn them on here and see
        what would be sent: AI assistance (the highlights you select, to the AI provider you choose)
        and sync (your study data, to a sync server you choose). Both are off by default.
      </p>
      <div>
        <h3>What is stored on this device</h3>
        <ul className="opt-bullets">
          <li>
            Each passage you save, exactly as written (up to {MAX_QUOTE_CHARS.toLocaleString('en')}{' '}
            characters), plus a simplified copy (lower case, single spaces) and a SHA-256
            fingerprint of it, used to spot the same passage saved twice and for search.
          </li>
          <li>
            Where it came from: the page address, the address the page declares as its own if it
            declares one, the page title (up to {MAX_TITLE_CHARS} characters) and the site name. The
            address is saved without a user name or password, without query parameters named like a
            token, key, code, signature or session, and without a #fragment unless the fragment is a
            page route. Other parts of the address, such as tracking parameters, are kept as you
            visited.
          </li>
          <li>
            What lets StudyVault find the passage again on a later visit: up to {MAX_CONTEXT_CHARS}{' '}
            characters of the page text just before it and just after it, the nearest heading above
            it (up to {MAX_HEADING_CHARS} characters), a short description of where it sits in the
            page structure, its position in the page text, and a hash and the length of the whole
            page text at the time you saved it. The hash and the length are only used to notice that
            the page changed; the page text itself is not stored.
          </li>
          <li>
            What you add: your note, the kind, the colour, the priority, the banks it is in, how you
            saved it and when.
          </li>
          <li>Whether the passage was found on the page at its last check, and when.</li>
          <li>
            These settings, including the sites you enabled and your deny list. A highlight id is
            also held in memory for a few seconds while the side panel opens for a note, then
            removed.
          </li>
        </ul>
        <p>
          If you use the other features, this device also holds: flashcards and your review history;
          PDF documents you opened in the reader (title, page count, any text recognised from scans,
          and a copy of the file only if you chose to keep one); AI suggestions, which are labelled
          unverified, the provider address and model you set, a usage count and, if you saved one,
          your API key kept in the extension&apos;s storage without extra encryption (it is never
          written to backups); and, if you turn sync on, the server address and a record of what has
          been sent.
        </p>
        <p>
          <strong>Deleted highlights stay on this device until you delete all data.</strong>{' '}
          Deleting a highlight only hides it, so Undo works. &ldquo;Delete all StudyVault
          data&rdquo; under <a href="#data">Your data</a> removes them for good.
        </p>
        <p className="sv-muted sv-small">
          StudyVault does not read pages you have not enabled, and it never reads your browsing
          history.
        </p>
      </div>
      <div>
        <h3>What a website can see</h3>
        <ul className="opt-bullets">
          <li>
            Highlights are painted through the page&apos;s shared highlight list. Scripts that the
            site itself runs can read that list: which passages of the page are highlighted, and
            each highlight&apos;s colour and kind (the names look like{' '}
            <code>sv-hl-amber-formula</code>
            ). They cannot read your notes, banks or anything else StudyVault stores.
          </li>
          <li>
            Sites on your deny list are never painted. You can also stop painting everywhere with
            &ldquo;Show highlights on pages&rdquo; under Appearance.
          </li>
          <li>A page can tell that StudyVault is running on it.</li>
          <li>
            Notes and bank names are typed in StudyVault&apos;s own panel, not in the page, so the
            page cannot see them as you type.
          </li>
        </ul>
      </div>
      <div>
        <h3>Permissions this extension holds</h3>
        <ul className="opt-bullets">
          {permissions.map((p) => (
            <li key={p}>
              <code>{p}</code>
              {PERMISSION_PURPOSES[p] ? ` — ${PERMISSION_PURPOSES[p]}` : ''}
            </li>
          ))}
        </ul>
        {optional.length > 0 ? (
          <>
            <p>Asked for later, only from a button and only for the feature that needs it:</p>
            <ul className="opt-bullets">
              {optional.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                  {PERMISSION_PURPOSES[p] ? ` — ${PERMISSION_PURPOSES[p]}` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="sv-muted sv-small">
          Access to websites is not among them. It is requested only when you enable a site above,
          open a PDF from the web in the reader, or point AI or sync at an address of your choice.
          Each request names the one site and Chrome asks you first.
        </p>
      </div>
    </section>
  );
}

export function About() {
  const uid = useId();
  const manifest = browser.runtime.getManifest();
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>About</h2>
      <p>
        {manifest.name} <span className="sv-muted">version {manifest.version}</span>
      </p>
    </section>
  );
}

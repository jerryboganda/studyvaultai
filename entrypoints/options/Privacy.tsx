import { useId } from 'react';
import { browser } from 'wxt/browser';
import { PERMISSION_PURPOSES } from './model';

export function Privacy() {
  const uid = useId();
  const manifest = browser.runtime.getManifest();
  const permissions = manifest.permissions ?? [];
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Privacy</h2>
      <p>
        <strong>Everything stays on this device.</strong> StudyVault has no account, no analytics
        and no server. It does not send your highlights, notes or browsing anywhere.
      </p>
      <div>
        <h3>What is stored on this device</h3>
        <ul className="opt-bullets">
          <li>
            The passages you choose to save, exactly as written, with the page title, address and
            time.
          </li>
          <li>Your notes, banks, kinds, priorities and where each passage sits on its page.</li>
          <li>These settings.</li>
        </ul>
        <p className="sv-muted sv-small">
          StudyVault does not read pages you have not enabled, and it never reads your browsing
          history.
        </p>
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
        <p className="sv-muted sv-small">
          Access to websites is not among them. It is requested only when you enable a site above.
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

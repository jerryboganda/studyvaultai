import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Eye,
  HardDrive,
  KeyRound,
  Map as MapIcon,
  Send,
  Signpost,
  type LucideIcon,
} from 'lucide-react';
import { MAX_CONTEXT_CHARS, MAX_HEADING_CHARS, MAX_QUOTE_CHARS, MAX_TITLE_CHARS } from '@shared';
import { InfoTip, InlineNotice, VaultBuddy, useAction, type ArtTone } from '@ui';
import { openOnboarding } from '@ui/shell/open';
import {
  getOnboardingState,
  watchOnboardingState,
  type OnboardingState,
} from '@ui/shell/onboardingState';
import { PERMISSION_PURPOSES } from './model';
import { Act, ArtTile, Card, More } from './ui';

function Fact({
  icon,
  tone,
  title,
  line,
  info,
}: {
  icon: LucideIcon;
  tone: ArtTone;
  title: string;
  line: string;
  info: string;
}) {
  return (
    <li className="opt-fact">
      <ArtTile icon={icon} tone={tone} size="lg" />
      <div className="opt-fact__text">
        <h2 className="opt-fact__title">{title}</h2>
        <p className="opt-fact__line">{line}</p>
      </div>
      <InfoTip label={`About ${title.toLowerCase()}`} align="end">
        {info}
      </InfoTip>
    </li>
  );
}

export function Privacy({ syncOn }: { syncOn: boolean }) {
  const manifest = browser.runtime.getManifest();
  const permissions = manifest.permissions ?? [];
  // Asked for later, from a click, and only for the feature that needs them (never at install).
  const optional = manifest.optional_permissions ?? [];
  return (
    <div className="opt-stack">
      <ul className="opt-factgrid">
        <Fact
          icon={HardDrive}
          tone="success"
          title="Stays here"
          line="Everything stays on this device by default."
          info="StudyVault has no account, no analytics and no server of its own, and does not send your highlights, notes or browsing anywhere."
        />
        <Fact
          icon={Send}
          tone="violet"
          title="Your choice"
          line="AI and sync send data only once you turn them on."
          info="AI sends the highlights you select to the provider you choose, each address listed first. Sync sends your study data to a server you choose. Both are off by default."
        />
        <Fact
          icon={Eye}
          tone="warning"
          title="What sites see"
          line="A site can see which passages are painted."
          info="Site scripts can read the painted passages and their colour and kind, never your notes or banks. Deny-listed sites are never painted, and Appearance can turn painting off."
        />
        <Fact
          icon={KeyRound}
          tone="primary"
          title="Permissions"
          line={`${permissions.length} held, more only when you ask.`}
          info="Access to websites is not among them. Chrome asks you first, for one site at a time, when you turn a site on, open a PDF from the web, or set up AI or sync."
        />
      </ul>

      {syncOn ? (
        <InlineNotice tone="warning" title="Sync is on">
          Your study data is also on the sync server you chose. Manage it in{' '}
          <a href="#sync">Sync</a>.
        </InlineNotice>
      ) : null}

      <Card title="Full details" icon={MapIcon} tone="neutral">
        <More label="What is stored on this device">
          <ul className="opt-bullets">
            <li>
              Each passage you save, exactly as written (up to{' '}
              {MAX_QUOTE_CHARS.toLocaleString('en')} characters), plus a simplified copy (lower
              case, single spaces) and a SHA-256 fingerprint of it, used to spot the same passage
              saved twice and for search.
            </li>
            <li>
              Where it came from: the page address, the address the page declares as its own if it
              declares one, the page title (up to {MAX_TITLE_CHARS} characters) and the site name.
              The address is saved without a user name or password, without query parameters named
              like a token, key, code, signature or session, and without a #fragment unless the
              fragment is a page route. Other parts of the address, such as tracking parameters, are
              kept as you visited.
            </li>
            <li>
              What lets StudyVault find the passage again on a later visit: up to{' '}
              {MAX_CONTEXT_CHARS} characters of the page text just before it and just after it, the
              nearest heading above it (up to {MAX_HEADING_CHARS} characters), a short description
              of where it sits in the page structure, its position in the page text, and a hash and
              the length of the whole page text at the time you saved it. The hash and the length
              are only used to notice that the page changed; the page text itself is not stored.
            </li>
            <li>
              What you add: your note, the kind, the colour, the priority, the banks it is in, how
              you saved it and when.
            </li>
            <li>Whether the passage was found on the page at its last check, and when.</li>
            <li>
              These settings, including the sites you enabled and your deny list. A highlight id is
              also held in memory for a few seconds while the side panel opens for a note, then
              removed.
            </li>
            <li>
              Your progress for the game layer: the XP each review, save, new card and finished
              session earned and when, your daily goal, and whether Game mode is on.
            </li>
          </ul>
          <p>
            If you use the other features, this device also holds: flashcards and your review
            history; your auto-filing rules, syllabi and the links you draw between items; an exam
            in progress and your exam history; the daily study reminder setting; a reference to the
            backup folder you chose (the backup files stay in that folder); PDF documents you opened
            in the reader (title, page count, any text recognised from scans, and a copy of the file
            only if you chose to keep one); AI suggestions, which are labelled unverified, the
            address and model of each AI provider you set (the main one and any fallbacks), a usage
            count and, if you saved them, your API keys kept in the extension&apos;s storage without
            extra encryption (they are never written to backups); and, if you turn sync on, the
            server address and a record of what has been sent.
          </p>
          <p>
            <strong>Deleted highlights stay in the trash on this device</strong> until you empty the
            trash in the dashboard or delete all data. Deleting a highlight only moves it there, so
            Undo works. &ldquo;Delete all data&rdquo; under <a href="#data">Your data</a> removes
            everything, trash included
            {syncOn ? ', from this device (not from your sync server)' : ''}.
          </p>
          <p>
            Opening a PDF from a web address in the StudyVault reader downloads it from that site,
            which then sees your IP address and the PDF address, like any visit.
          </p>
          <p className="sv-muted sv-small">
            StudyVault does not read pages you have not enabled, and it never reads your browsing
            history.
          </p>
        </More>
        <More label="What a website can see">
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
              &ldquo;Show on pages&rdquo; under Appearance.
            </li>
            <li>A page can tell that StudyVault is running on it.</li>
            <li>
              Notes and bank names are typed in StudyVault&apos;s own panel, not in the page, so the
              page cannot see them as you type.
            </li>
          </ul>
        </More>
        <More label="Permissions this extension holds">
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
            Access to websites is not among them. It is requested only when you enable a site, open
            a PDF from the web in the reader, or point AI or sync at an address of your choice. Each
            request names the one site and Chrome asks you first.
          </p>
        </More>
      </Card>
    </div>
  );
}

/** Where the welcome tour stands, so the button can say "Resume" instead of "Show". */
function useTourState(): OnboardingState | null {
  const [state, setState] = useState<OnboardingState | null>(null);
  useEffect(() => {
    let live = true;
    getOnboardingState().then(
      (s) => {
        if (live) setState((cur) => cur ?? s);
      },
      () => undefined, // The button then just offers the tour; nothing else depends on this.
    );
    const stop = watchOnboardingState((s) => setState(s));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

export function About() {
  const manifest = browser.runtime.getManifest();
  const tour = useTourState();
  const welcome = useAction(() => openOnboarding());
  const resume = tour?.status === 'pending' && tour.step !== 'welcome';
  return (
    <div className="opt-stack">
      <div className="opt-card opt-about">
        <VaultBuddy pose="wave" size={96} />
        <div className="opt-about__text">
          <p className="opt-about__name">{manifest.name}</p>
          <p className="opt-about__version">
            <span className="opt-count">version {manifest.version}</span>
          </p>
          <p className="sv-muted">Local-first study companion. No account needed.</p>
        </div>
      </div>
      {/* Open dashboard lives on the settings home; this card does one thing. */}
      <Card title="Welcome tour" icon={Signpost} tone="sun">
        <p className="opt-line">Walk through the basics again.</p>
        <div className="sv-row">
          <Act
            variant="primary"
            icon={Signpost}
            busy={welcome.busy}
            onClick={() => void welcome.run()}
          >
            {resume ? 'Resume tour' : 'Welcome tour'}
          </Act>
        </div>
        {welcome.error ? (
          <InlineNotice tone="error" title="Could not open that page">
            {welcome.error}
          </InlineNotice>
        ) : null}
      </Card>
    </div>
  );
}

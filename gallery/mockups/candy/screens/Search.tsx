// Offline search over the sample highlights, shared by the side panel and the dashboard overlay.
import { Fragment, useId, useState, type Ref } from 'react';
import { Search } from 'lucide-react';
import { HIGHLIGHTS, bankOf, kindOf } from '../data';
import { VaultBuddy } from '../VaultBuddy';

function Marked({ text, q }: { text: string; q: string }) {
  const parts: { t: string; hit: boolean }[] = [];
  const low = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = low.indexOf(needle); needle && i >= 0; i = low.indexOf(needle, at)) {
    if (i > at) parts.push({ t: text.slice(at, i), hit: false });
    parts.push({ t: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  parts.push({ t: text.slice(at), hit: false });
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p.hit ? <mark>{p.t}</mark> : p.t}</Fragment>
      ))}
    </>
  );
}

export function SearchBox({ inputRef }: { inputRef?: Ref<HTMLInputElement> }) {
  const id = useId();
  const [q, setQ] = useState('');
  const term = q.trim();
  const hits = term
    ? HIGHLIGHTS.filter(
        (h) =>
          h.quote.toLowerCase().includes(term.toLowerCase()) ||
          h.tags.some((t) => t.includes(term.toLowerCase())),
      )
    : [];
  return (
    <div className="sv-searchbox">
      <div className="sv-search" role="search">
        <Search aria-hidden="true" strokeWidth={2.5} />
        <label htmlFor={id} className="sv-vh">
          Search your vault
        </label>
        <input
          ref={inputRef}
          id={id}
          className="sv-input sv-input--search"
          type="search"
          placeholder="Search your vault"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <p className="sv-hint sv-searchbox__status" role="status">
        {term ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} · offline` : ''}
      </p>
      {!term ? (
        <div className="sv-empty sv-searchbox__empty">
          <VaultBuddy pose="think" size={96} />
          <p>
            Try <strong>heart</strong> or <strong>potassium</strong>
          </p>
        </div>
      ) : hits.length ? (
        <ul className="sv-hits">
          {hits.map((h) => {
            const b = bankOf(h.bank);
            const k = kindOf(h.kind);
            const BankIcon = b.icon;
            return (
              <li key={h.id} className="sv-hit" data-tone={k.tone}>
                <p className="sv-hit__q">
                  <Marked text={h.quote} q={term} />
                </p>
                <span className="sv-chip" data-tone={b.tone}>
                  <BankIcon aria-hidden="true" strokeWidth={2.6} />
                  {b.name}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="sv-empty sv-searchbox__empty">
          <VaultBuddy pose="sleep" size={88} />
          <p>No matches</p>
        </div>
      )}
    </div>
  );
}

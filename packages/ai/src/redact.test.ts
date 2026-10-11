// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyRegions, detectRegions, luhnValid, resolveRegions } from './redact';
import { scrubSecrets } from './secrets';
import { sanitizeSourceText, toPlainText } from './text';

const kinds = (text: string) => detectRegions('c1', text).map((r) => [r.kind, r.original]);

describe('redaction detectors', () => {
  it('finds emails', () => {
    expect(kinds('Write to jane.doe+study@example.co.uk today.')).toEqual([
      ['email', 'jane.doe+study@example.co.uk'],
    ]);
  });

  it('finds phone numbers in international, US and local formats but not years or doses', () => {
    expect(kinds('Call +44 20 7946 0958 now')).toEqual([['phone', '+44 20 7946 0958']]);
    expect(kinds('Call (415) 555-2671 now')).toEqual([['phone', '(415) 555-2671']]);
    expect(kinds('Call 01632 960 001 now')).toEqual([['phone', '01632 960 001']]);
    expect(kinds('Studies 2015-2019 reported 120 mg and 1,500 patients.')).toEqual([]);
  });

  it('flags card numbers only when the Luhn check passes', () => {
    expect(luhnValid('4539578763621486')).toBe(true);
    expect(luhnValid('4539578763621487')).toBe(false);
    expect(kinds('card 4539 5787 6362 1486 end')).toEqual([['card', '4539 5787 6362 1486']]);
    // Same length, bad checksum: not a card (and not a phone either, digits only).
    expect(kinds('ref 4539 5787 6362 1487 end')).toEqual([]);
  });

  it('flags national-id-like numbers', () => {
    expect(kinds('SSN 123-45-6789.')).toEqual([['national_id', '123-45-6789']]);
    expect(kinds('الرقم 29901011234567 ok')).toEqual([['national_id', '29901011234567']]);
    expect(kinds('National ID: AB1234567 on file')).toEqual([['national_id', 'AB1234567']]);
    expect(kinds('NI number AB 12 34 56 C')).toEqual([['national_id', 'AB 12 34 56 C']]);
    expect(kinds('MRN 88231907')).toEqual([['national_id', '88231907']]);
  });

  it('flags API-key-like strings, bearer tokens and key assignments', () => {
    const key = 'sk-ant-api03-AbCdEf1234567890_ghIJkl-MNop';
    expect(kinds(`use ${key} here`)).toEqual([['api_key', key]]);
    expect(kinds('AKIAIOSFODNN7EXAMPLE')).toEqual([['api_key', 'AKIAIOSFODNN7EXAMPLE']]);
    expect(kinds('Authorization: Bearer abcdEFGH1234567890zzzz')).toEqual([
      ['api_key', 'abcdEFGH1234567890zzzz'],
    ]);
    expect(kinds('api_key = "s3cr3tValue99"')).toEqual([['api_key', 's3cr3tValue99']]);
    expect(kinds('token 9fB2kQ7xLm3ZpV8wT1yU4nC6dR0aS5hJ')).toEqual([
      ['api_key', '9fB2kQ7xLm3ZpV8wT1yU4nC6dR0aS5hJ'],
    ]);
  });

  it('does not flag ordinary long words or prose', () => {
    expect(
      kinds('Electroencephalographically unremarkable immunohistochemistry findings.'),
    ).toEqual([]);
  });

  it('flags URLs with credentials or tokens, keeps clean URLs', () => {
    expect(kinds('see https://user:hunter2@example.com/a ok')).toEqual([
      ['url_secret', 'https://user:hunter2@example.com/a'],
    ]);
    expect(kinds('go https://x.com/cb?access_token=abc123&u=1.')).toEqual([
      ['url_secret', 'https://x.com/cb?access_token=abc123&u=1'],
    ]);
    expect(kinds('doc https://x.com/reset/9fB2kQ7xLm3ZpV8wT1yU4nC6dR0aS5hJ')).toEqual([
      ['url_secret', 'https://x.com/reset/9fB2kQ7xLm3ZpV8wT1yU4nC6dR0aS5hJ'],
    ]);
    expect(kinds('read https://en.wikipedia.org/wiki/Metformin?section=2')).toEqual([]);
  });

  it('earlier detectors win overlaps (a URL containing an email is one URL region)', () => {
    const r = detectRegions('c1', 'https://x.com/?token=a@b.co&id=1');
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe('url_secret');
  });
});

describe('user-editable regions', () => {
  const text = 'Mail jane@example.com or 555-123-4567 about SSN 123-45-6789.';

  it('applies placeholders by default', () => {
    const regions = resolveRegions('c1', text, undefined);
    expect(applyRegions(text, regions)).toBe('Mail [EMAIL] or [PHONE] about SSN [ID_NUMBER].');
  });

  it('keeping a region sends the original text', () => {
    const email = detectRegions('c1', text).find((r) => r.kind === 'email')!;
    const regions = resolveRegions('c1', text, { keep: [email.id] });
    expect(regions.find((r) => r.id === email.id)?.enabled).toBe(false);
    expect(applyRegions(text, regions)).toContain('jane@example.com');
    expect(applyRegions(text, regions)).not.toContain('123-45-6789');
  });

  it('hand-marked regions are redacted too; out-of-range or overlapping marks are ignored', () => {
    const s = 'Dr Smith treated the patient at Springfield General.';
    const start = s.indexOf('Springfield General');
    const regions = resolveRegions('c1', s, {
      add: [
        { chunkId: 'c1', start, end: start + 'Springfield General'.length },
        { chunkId: 'other', start: 0, end: 5 },
        { chunkId: 'c1', start: 9999, end: 99999 },
      ],
    });
    expect(applyRegions(s, regions)).toBe('Dr Smith treated the patient at [REDACTED].');
  });
});

describe('text hygiene', () => {
  it('removes zero-width, bidi, tag and control characters but keeps newlines', () => {
    const tag = String.fromCodePoint(0xe0041, 0xe0042);
    const s = `ig\u200Bnore\u202E prev\u0007ious${tag}\nline2\u2028line3`;
    expect(sanitizeSourceText(s)).toBe('ignore previous\nline2\nline3');
  });

  it('toPlainText strips markup, scripts and links', () => {
    const dirty =
      'Hello <b>world</b><script>alert(1)</script> [click](javascript:alert(1)) ![x](https://evil.test/?q=1) ' +
      'see https://evil.test/a?b=c and www.evil.test/x <img src=x onerror=alert(1)> BP < 90 mmHg';
    const clean = toPlainText(dirty);
    expect(clean).not.toMatch(/<\/?(b|script|img)/i);
    expect(clean).not.toContain('alert(1)');
    expect(clean).not.toContain('evil.test');
    expect(clean).toContain('Hello world');
    expect(clean).toContain('click');
    expect(clean).toContain('BP < 90 mmHg');
  });
});

describe('scrubSecrets', () => {
  it('replaces known secrets (raw and url-encoded) and key-shaped strings', () => {
    const secret = 'my/own+secret value';
    const out = scrubSecrets(
      `failed with ${secret} and ${encodeURIComponent(secret)} and sk-live-ABCDEFGHIJKLMNOPQRSTUV`,
      [secret],
    );
    expect(out).not.toContain('own+secret');
    expect(out).not.toContain('sk-live');
    expect(out).toContain('[REDACTED]');
  });
});

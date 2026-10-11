// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_DENY_HOSTS, DENY_HOST, DENY_LIST_SCOPE_NOTE, isHostDenied } from './index';

describe('DEFAULT_DENY_HOSTS (starter list)', () => {
  it('is a sizeable list of unique, lowercase hostnames that can become excludeMatches', () => {
    expect(DEFAULT_DENY_HOSTS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(DEFAULT_DENY_HOSTS).size).toBe(DEFAULT_DENY_HOSTS.length);
    for (const host of DEFAULT_DENY_HOSTS) {
      expect(host, host).toBe(host.toLowerCase());
      expect(host, host).toMatch(DENY_HOST);
    }
  });

  it('keeps the original entries', () => {
    for (const host of [
      'accounts.google.com',
      'login.microsoftonline.com',
      'login.live.com',
      'appleid.apple.com',
      'mail.google.com',
      'outlook.live.com',
      'outlook.office.com',
      'outlook.office365.com',
      'paypal.com',
      'chromewebstore.google.com',
      'chrome.google.com',
    ]) {
      expect(DEFAULT_DENY_HOSTS, host).toContain(host);
    }
  });

  it('covers the categories it claims, including bank sites in several countries', () => {
    const covered = [
      'https://online.chase.com/', // US bank
      'https://www.barclays.co.uk/', // UK
      'https://www.ing.com/', // EU
      'https://netbanking.hdfcbank.com/', // IN
      'https://www.commbank.com.au/', // AU
      'https://www.rbc.com/', // CA
      'https://mail.proton.me/inbox', // mail
      'https://login.paypal.com/', // payment
      'https://dashboard.stripe.com/', // payment
      'https://mychart.com/', // health-record portal
      'https://access.login.nhs.uk/', // health sign-in
    ];
    for (const url of covered) {
      expect(isHostDenied(new URL(url).hostname, DEFAULT_DENY_HOSTS), url).toBe(true);
    }
  });

  it('does not block ordinary study sites', () => {
    for (const host of [
      'en.wikipedia.org',
      'docs.stripe.com',
      'developer.mozilla.org',
      'docs.google.com',
      'www.nhs.uk',
    ]) {
      expect(isHostDenied(host, DEFAULT_DENY_HOSTS), host).toBe(false);
    }
  });

  it('is described honestly for the UI', () => {
    expect(DENY_LIST_SCOPE_NOTE).toMatch(/starter list/i);
    expect(DENY_LIST_SCOPE_NOTE).toMatch(/banks vary by country/i);
  });
});

describe('zod configuration', () => {
  it('interprets parsers instead of probing Function() (CSP-safe)', () => {
    expect(z.config().jitless).toBe(true);
    // Cached by the first schema built: false means the Function('') probe never ran.
    expect(z.core.util.allowsEval.value).toBe(false);
  });
});

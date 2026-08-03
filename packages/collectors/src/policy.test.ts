import { describe, it, expect } from 'vitest';
import {
  checkHost,
  parseRobots,
  robotsAllows,
  effectiveDelayMs,
  stripPii,
  containsPii,
  MIN_INTERVAL_MS,
  USER_AGENT,
} from './policy.js';

describe('host policy — the never-scrape list', () => {
  it.each([
    'https://www.linkedin.com/company/x',
    'https://instagram.com/someone',
    'https://www.tiktok.com/@x',
    'https://x.com/status/1',
    'https://m.facebook.com/page',
  ])('refuses %s', (url) => {
    const v = checkHost(url);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/never-scrape/);
  });

  it('allows an ordinary competitor site', () => {
    expect(checkHost('https://www.jiffyondemand.com/services').allowed).toBe(true);
  });

  it('refuses a subdomain of a banned host too', () => {
    expect(checkHost('https://business.linkedin.com/x').allowed).toBe(false);
  });
});

describe('robots.txt as a HARD gate', () => {
  const robots = `
    User-agent: *
    Disallow: /admin
    Disallow: /private
    Allow: /private/public-page
    Crawl-delay: 5

    User-agent: BadBot
    Disallow: /
  `;

  it('blocks a disallowed path', () => {
    const r = parseRobots(robots);
    expect(robotsAllows(r, 'https://example.com/admin/users').allowed).toBe(false);
  });

  it('honours a more specific Allow over a broader Disallow', () => {
    const r = parseRobots(robots);
    expect(robotsAllows(r, 'https://example.com/private/public-page').allowed).toBe(true);
    expect(robotsAllows(r, 'https://example.com/private/secret').allowed).toBe(false);
  });

  it('allows anything not disallowed', () => {
    expect(robotsAllows(parseRobots(robots), 'https://example.com/blog/post').allowed).toBe(true);
  });

  it('honours Crawl-delay, and never goes faster than our own floor', () => {
    expect(effectiveDelayMs(parseRobots(robots))).toBe(5000); // theirs is stricter
    expect(effectiveDelayMs(parseRobots('User-agent: *\nCrawl-delay: 1'))).toBe(MIN_INTERVAL_MS);
    expect(effectiveDelayMs(null)).toBe(MIN_INTERVAL_MS);
  });

  it('ignores rules addressed to a different agent', () => {
    const onlyBadBot = parseRobots('User-agent: BadBot\nDisallow: /');
    expect(robotsAllows(onlyBadBot, 'https://example.com/anything').allowed).toBe(true);
  });
});

describe('PII is stripped at ingest, not at query time', () => {
  it('removes emails, phone numbers and handles', () => {
    const raw = 'Contact jane.doe@example.com or +1 (416) 555-0199, or DM @jane_doe about it.';
    const clean = stripPii(raw);
    expect(clean).not.toContain('jane.doe@example.com');
    expect(clean).not.toContain('555-0199');
    expect(clean).not.toContain('@jane_doe');
    expect(containsPii(clean)).toBe(false);
  });

  it('leaves the analysable signal intact', () => {
    const clean = stripPii('Jiffy raised prices 12% in Toronto, per jane@x.com');
    expect(clean).toContain('Jiffy raised prices 12% in Toronto');
  });

  it('does NOT redact dates, versions or metrics — over-redaction destroys the signal', () => {
    // A one-stage phone regex eats all of these: they are digit runs built from
    // the same separator set as a phone number. Corrupting every date we ingest
    // is a worse failure than missing a phone number.
    for (const safe of [
      'published 2026-07-25 in Toronto',
      'window 2026-07-25 to 2026-08-01',
      'macOS 10.15.7 (19H2) build notes',
      'impressions 1240 clicks 96 position 4.2',
      'ranked 3 (up from 11) on 2026-07-25',
    ]) {
      expect(stripPii(safe)).toBe(safe);
    }
  });

  it('still redacts real phone formats', () => {
    for (const phone of ['+1 (416) 555-0199', '416-555-0199', '4165550199', '+91 98765 43210']) {
      expect(stripPii(`call ${phone} now`)).toBe('call [phone] now');
    }
  });

  it('containsPii agrees with stripPii on the same input', () => {
    expect(containsPii('published 2026-07-25')).toBe(false);
    expect(containsPii('call 416-555-0199')).toBe(true);
  });
});

describe('identification', () => {
  it('identifies honestly with a contact address and an opt-out path', () => {
    expect(USER_AGENT).toMatch(/TasklyBot/);
    expect(USER_AGENT).toMatch(/https?:\/\//);
    expect(USER_AGENT).toMatch(/@/);
  });
});

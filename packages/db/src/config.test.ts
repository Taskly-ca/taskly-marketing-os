import { describe, it, expect } from 'vitest';
import { loadDbConfig, sslFor } from './config.js';

const url = 'postgresql://user:pw@db.abcdefgh.supabase.co:5432/postgres';

describe('db config', () => {
  it('REFUSES to start without DATABASE_URL — never falls back to localhost', () => {
    let message = '';
    try {
      loadDbConfig({});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    // The failure must name the variable and say it is required. A silent
    // localhost default is how a migration "succeeds" against nothing.
    expect(message).toMatch(/required|expected/i);
  });

  it('rejects a connection string that is not postgres', () => {
    expect(() => loadDbConfig({ DATABASE_URL: 'mysql://user@host/db' })).toThrow(/postgres/i);
    expect(() => loadDbConfig({ DATABASE_URL: 'not a url at all' })).toThrow(/postgres/i);
  });

  it('applies conservative defaults', () => {
    const cfg = loadDbConfig({ DATABASE_URL: url });
    expect(cfg.url).toBe(url);
    expect(cfg.poolMax).toBe(10);
    expect(cfg.statementTimeoutMs).toBe(15_000);
    expect(cfg.connectionTimeoutMs).toBeGreaterThan(0);
  });

  it('coerces the optional numeric overrides from strings', () => {
    const cfg = loadDbConfig({
      DATABASE_URL: url,
      DATABASE_POOL_MAX: '4',
      DATABASE_STATEMENT_TIMEOUT_MS: '2500',
    });
    expect(cfg.poolMax).toBe(4);
    expect(cfg.statementTimeoutMs).toBe(2_500);
  });

  it('rejects nonsense overrides rather than quietly using a default', () => {
    for (const bad of ['0', '-1', 'abc', '2.5']) {
      expect(() => loadDbConfig({ DATABASE_URL: url, DATABASE_POOL_MAX: bad })).toThrow(
        /DATABASE_POOL_MAX/,
      );
    }
  });

  describe('ssl', () => {
    it('is off for a local database', () => {
      expect(sslFor('postgresql://postgres@localhost:5432/tmos')).toBe(false);
      expect(sslFor('postgresql://postgres@127.0.0.1:5432/tmos')).toBe(false);
    });

    it('is ON for a remote database — Supabase refuses plaintext', () => {
      expect(sslFor(url)).toEqual({ rejectUnauthorized: false });
    });

    it('honours libpq sslmode', () => {
      expect(sslFor(`${url}?sslmode=disable`)).toBe(false);
      expect(sslFor(`${url}?sslmode=require`)).toEqual({ rejectUnauthorized: false });
      expect(sslFor(`${url}?sslmode=verify-full`)).toEqual({ rejectUnauthorized: true });
      expect(sslFor(`${url}?sslmode=verify-ca`)).toEqual({ rejectUnauthorized: true });
      // sslmode=disable on a LOCAL url is still off, not accidentally re-enabled.
      expect(sslFor('postgresql://postgres@localhost:5432/tmos?sslmode=disable')).toBe(false);
    });

    it('is carried into the loaded config', () => {
      expect(loadDbConfig({ DATABASE_URL: url }).ssl).toEqual({ rejectUnauthorized: false });
      expect(loadDbConfig({ DATABASE_URL: 'postgres://postgres@localhost/tmos' }).ssl).toBe(false);
    });
  });
});

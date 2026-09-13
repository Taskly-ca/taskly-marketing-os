import 'server-only';

/**
 * Where the console (apps/console) listens. On Railway both processes share
 * one container and the console stays on loopback; the web app is the only
 * thing on the public port. The console's own password gate is satisfied
 * server-side here, so the browser never sees it.
 */
export const CONSOLE_URL = (process.env['TMOS_CONSOLE_URL'] ?? 'http://127.0.0.1:4478').replace(/\/$/, '');

export function consoleHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const password = process.env['TMOS_CONSOLE_PASSWORD']?.trim();
  const out: Record<string, string> = { ...extra };
  if (password) out['authorization'] = `Basic ${Buffer.from(`web:${password}`, 'utf8').toString('base64')}`;
  return out;
}

/** A server-side GET against the console's JSON API, for pages that render with data already in hand. */
export async function consoleJson<T>(path: string): Promise<T> {
  const res = await fetch(`${CONSOLE_URL}${path}`, { headers: consoleHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`console ${path} → ${res.status}`);
  return (await res.json()) as T;
}

import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * One shared sign-in, from the environment. `TMOS_CONSOLE_PASSWORD` is the
 * same secret the console itself demands (see apps/console/src/server.ts), so
 * there is exactly one password to rotate; the username defaults to `taskly`.
 */
const USERNAME = process.env['TMOS_CONSOLE_USERNAME']?.trim() || 'taskly';
const PASSWORD = process.env['TMOS_CONSOLE_PASSWORD']?.trim() ?? '';

type AccountState = 'ready' | 'needs-setup';
export const accountState = (): AccountState => (PASSWORD.length >= 12 ? 'ready' : 'needs-setup');

const digest = (s: string) => createHash('sha256').update(s.normalize('NFKC')).digest();

/** Constant-time on both halves, so timing does not say which one was wrong. */
export function checkCredentials(username: string, password: string): boolean {
  if (accountState() !== 'ready') return false;
  const userOk = timingSafeEqual(digest(username.trim()), digest(USERNAME));
  const passOk = timingSafeEqual(digest(password.trim()), digest(PASSWORD));
  return userOk && passOk;
}

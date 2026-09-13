import 'server-only';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Signed-cookie sessions. TMOS keeps its state in Postgres and the web app
 * deliberately adds no table for this: the cookie carries `expiry.nonce.sig`,
 * where the signature is an HMAC over the first two under a server secret.
 * Rotate `TMOS_SESSION_SECRET` (or the console password it is derived from)
 * and every session is signed out at once — the "sign out every device" that a
 * table would otherwise exist to provide.
 */
export const SESSION_COOKIE = 'tmos_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Session = { expiresAt: number };

function secret(): Buffer {
  const explicit = process.env['TMOS_SESSION_SECRET']?.trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const derived = process.env['TMOS_CONSOLE_PASSWORD']?.trim();
  if (!derived) throw new Error('TMOS_SESSION_SECRET or TMOS_CONSOLE_PASSWORD must be set for sign-in to work');
  return createHash('sha256').update(`tmos-session:${derived}`).digest();
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

function mintToken(now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + TTL_MS;
  const payload = `${expiresAt}.${randomBytes(16).toString('base64url')}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function readToken(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [exp, nonce, sig] = parts as [string, string, string];
  const expected = sign(`${exp}.${nonce}`);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { expiresAt };
}

async function isSecureRequest(): Promise<boolean> {
  const h = await headers();
  return h.get('x-forwarded-proto') === 'https' || (process.env['TMOS_PUBLIC_URL'] ?? '').startsWith('https://');
}

export async function startSession(): Promise<void> {
  const { token, expiresAt } = mintToken();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: await isSecureRequest(), path: '/', expires: new Date(expiresAt),
  });
}

export async function currentSession(): Promise<Session | null> {
  return readToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For pages: the session, or a redirect to sign in. */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

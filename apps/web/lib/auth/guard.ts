import 'server-only';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readToken, SESSION_COOKIE, type Session } from './session';

/** Route-handler guards. Cookies are SameSite=Lax; anything that changes state must also come from our own origin. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try { return new URL(origin).host === host; } catch { return false; }
}

export const jsonError = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

export async function apiSession(req: Request, { mutating }: { mutating: boolean }): Promise<Session | NextResponse> {
  if (mutating && !sameOrigin(req)) return jsonError(403, 'This request came from another site.');
  const session = readToken((await cookies()).get(SESSION_COOKIE)?.value);
  return session ?? jsonError(401, 'Sign in again — your session has ended.');
}

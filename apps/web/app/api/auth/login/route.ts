import { NextResponse } from 'next/server';
import { checkCredentials } from '@/lib/auth/account';
import { startSession } from '@/lib/auth/session';
import { jsonError, sameOrigin } from '@/lib/auth/guard';
import { allow, clientIp } from '@/lib/auth/rate-limit';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'This request came from another site.');
  if (!allow(`login:${clientIp(req.headers)}`, 10, 15 * 60 * 1000)) {
    return jsonError(429, 'Too many attempts. Wait 15 minutes, then try again.');
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const username = typeof body?.['username'] === 'string' ? body['username'] : '';
  const password = typeof body?.['password'] === 'string' ? body['password'] : '';
  if (!checkCredentials(username, password)) return jsonError(401, 'That username and password don’t match.');
  await startSession();
  return NextResponse.json({ ok: true });
}

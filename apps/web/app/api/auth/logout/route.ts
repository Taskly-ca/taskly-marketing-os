import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth/session';
import { jsonError, sameOrigin } from '@/lib/auth/guard';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'This request came from another site.');
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

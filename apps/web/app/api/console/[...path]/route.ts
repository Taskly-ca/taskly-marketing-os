import { NextResponse } from 'next/server';
import { apiSession } from '@/lib/auth/guard';
import { CONSOLE_URL, consoleHeaders } from '@/lib/console';

/**
 * The browser's only door to the console: every `/api/console/<x>` call is
 * checked for a session, then forwarded to the console's `/api/<x>` with the
 * query string, the method and the body intact. Streams pass through untouched —
 * the answer engine and the run log are server-sent events, and buffering
 * either would turn "watch it work" into "wait for it".
 */
export const dynamic = 'force-dynamic';

async function forward(req: Request, params: Promise<{ path: string[] }>): Promise<Response> {
  const method = req.method.toUpperCase();
  const session = await apiSession(req, { mutating: method !== 'GET' && method !== 'HEAD' });
  if (session instanceof NextResponse) return session;

  const { path } = await params;
  const url = new URL(req.url);
  const target = `${CONSOLE_URL}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const headers = consoleHeaders({ accept: req.headers.get('accept') ?? '*/*' });
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : await req.arrayBuffer(),
      signal: req.signal,
      // @ts-expect-error — Node's fetch needs this to stream a request body; harmless elsewhere.
      duplex: 'half',
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'The console isn’t reachable right now.' }, { status: 502 });
  }

  const out = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  out.set('x-accel-buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => forward(req, ctx.params);
export const POST = GET;
export const DELETE = GET;

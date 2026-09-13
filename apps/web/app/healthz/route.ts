import { CONSOLE_URL } from '@/lib/console';

/** Unauthenticated on purpose: the platform health check learns only that both processes are up. */
export async function GET() {
  const ok = await fetch(`${CONSOLE_URL}/healthz`, { cache: 'no-store' }).then(r => r.ok).catch(() => false);
  return new Response(ok ? 'ok' : 'console down', { status: ok ? 200 : 503, headers: { 'content-type': 'text/plain' } });
}

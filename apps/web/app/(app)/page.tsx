import { consoleJson } from '@/lib/console';
import type { ThreadSummary } from '@/lib/threads';
import type { Mode } from '@/lib/answer';
import { Ask } from './_components/ask';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ demo?: string; mode?: string; q?: string }> }) {
  const sp = await searchParams;
  const demo = sp.demo === '1';
  const mode = sp.mode && ['web', 'grounded', 'verified', 'deep'].includes(sp.mode) ? (sp.mode as Mode) : undefined;
  const threads = await consoleJson<ThreadSummary[]>('/api/threads').then(t => ({ t, down: false })).catch(() => ({ t: [] as ThreadSummary[], down: true }));
  return <Ask threads={threads.t} thread={null} now={Date.now()} consoleDown={threads.down && !demo} demo={demo} initialMode={mode} initialQuestion={sp.q?.trim() || undefined} />;
}

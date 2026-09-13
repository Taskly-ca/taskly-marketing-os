import { consoleJson } from '@/lib/console';
import type { ThreadSummary } from '@/lib/threads';
import { Ask } from './_components/ask';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const threads = await consoleJson<ThreadSummary[]>('/api/threads').then(t => ({ t, down: false })).catch(() => ({ t: [] as ThreadSummary[], down: true }));
  return <Ask threads={threads.t} thread={null} now={Date.now()} consoleDown={threads.down} />;
}

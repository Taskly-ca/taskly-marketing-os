import { notFound } from 'next/navigation';
import { consoleJson } from '@/lib/console';
import type { ThreadSummary } from '@/lib/threads';
import type { ThreadDetail } from '@/lib/answer';
import { Ask } from '../../_components/ask';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [threads, thread] = await Promise.all([
    consoleJson<ThreadSummary[]>('/api/threads').catch(() => null),
    consoleJson<ThreadDetail>(`/api/threads/${id}`).catch((e: Error) => (e.message.endsWith('404') ? 'missing' : null)),
  ]);
  if (thread === 'missing') notFound();
  return <Ask threads={threads ?? []} thread={thread} now={Date.now()} consoleDown={threads === null} />;
}

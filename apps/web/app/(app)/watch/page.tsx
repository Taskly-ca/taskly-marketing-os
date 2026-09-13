import { consoleJson } from '@/lib/console';
import { TABS, type ConsoleState, type Question, type RunStatus, type Tab } from '@/lib/watch';
import { Watch } from './_components/watch';

export const dynamic = 'force-dynamic';

export default async function WatchPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const [state, questions, status] = await Promise.all([
    consoleJson<ConsoleState>('/api/state').catch(() => null),
    consoleJson<Question[]>('/api/questions').catch(() => null),
    consoleJson<RunStatus>('/api/status').catch(() => null),
  ]);
  const initialTab: Tab = TABS.some(t => t.id === tab) ? (tab as Tab) : 'changed';
  return <Watch state={state} questions={questions} status={status} initialTab={initialTab} />;
}

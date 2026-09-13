// The console's thread shapes, as they come back through /api/console/threads.
export type ThreadSummary = {
  id: string;
  title: string;
  titleSource: string;
  forkedFromMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  messageCount: number;
};

const TZ = 'America/Toronto';
const dayKey = (ts: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
const timeFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: 'numeric', month: 'short' });

/** "3:40 p.m." today, "4 Sept" otherwise — fixed zone and locale so server and browser agree. */
export function when(iso: string, now: number): string {
  const ts = Date.parse(iso);
  return dayKey(ts) === dayKey(now) ? timeFmt.format(ts) : dateFmt.format(ts);
}

/** Today · Yesterday · Previous 7 days · Earlier, in updated order. */
export function groupThreads(threads: ThreadSummary[], now: number): { label: string; items: ThreadSummary[] }[] {
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const weekAgo = now - 7 * 86_400_000;
  const groups = new Map<string, ThreadSummary[]>();
  for (const t of [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const ts = Date.parse(t.updatedAt);
    const k = dayKey(ts);
    const label = k === today ? 'Today' : k === yesterday ? 'Yesterday' : ts >= weekAgo ? 'Previous 7 days' : 'Earlier';
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

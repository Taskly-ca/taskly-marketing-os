import { describe, it, expect } from 'vitest';
import { buildEvent, createMemoryOutbox, idempotencyKey } from './events.js';

const ev = (over: Partial<Parameters<typeof buildEvent>[0]> = {}) =>
  buildEvent({
    type: 'signal.collected',
    occurredAt: '2026-08-03T10:00:00.000Z',
    payload: { url: 'https://example.com/a' },
    idempotencyKey: idempotencyKey({ source: 'rss', externalId: 'a', contentHash: 'h1' }),
    correlationId: '11111111-1111-4111-8111-111111111111',
    ...over,
  });

describe('transactional outbox', () => {
  it('writes the event and its queue message together', async () => {
    const outbox = createMemoryOutbox();
    const e = ev();
    const wrote = await outbox.append(e, [{ queue: 'gate', eventId: e.id, body: { a: 1 } }]);

    expect(wrote).toBe(true);
    expect(await outbox.all()).toHaveLength(1);
    expect(await outbox.pending('gate')).toHaveLength(1);
  });

  it('treats a duplicate idempotency key as a NO-OP, not an error', async () => {
    const outbox = createMemoryOutbox();
    const e = ev();
    expect(await outbox.append(e)).toBe(true);
    expect(await outbox.append(ev())).toBe(false); // same key, different uuid
    expect(await outbox.all()).toHaveLength(1);
  });

  it('does not enqueue work for a duplicate — no double processing', async () => {
    const outbox = createMemoryOutbox();
    const a = ev();
    await outbox.append(a, [{ queue: 'gate', eventId: a.id, body: {} }]);
    const b = ev();
    await outbox.append(b, [{ queue: 'gate', eventId: b.id, body: {} }]);
    expect(await outbox.pending('gate')).toHaveLength(1);
  });

  it('makes one investigation a single query via correlation_id', async () => {
    const outbox = createMemoryOutbox();
    const corr = '22222222-2222-4222-8222-222222222222';
    await outbox.append(ev({ correlationId: corr, idempotencyKey: 'k1' }));
    await outbox.append(ev({ correlationId: corr, idempotencyKey: 'k2' }));
    await outbox.append(ev({ idempotencyKey: 'k3' })); // different investigation

    expect(await outbox.byCorrelation(corr)).toHaveLength(2);
  });

  it('records causation so a belief can render its provenance chain', async () => {
    const outbox = createMemoryOutbox();
    const first = ev({ idempotencyKey: 'k1' });
    await outbox.append(first);
    await outbox.append(ev({ idempotencyKey: 'k2', causationId: first.id }));

    const all = await outbox.all();
    expect(all[1]!.causationId).toBe(first.id);
  });

  it('separates occurredAt (world time) from recordedAt (our time)', async () => {
    const e = buildEvent(
      {
        type: 't',
        occurredAt: '2026-07-01T00:00:00.000Z',
        payload: {},
        idempotencyKey: 'k',
        correlationId: 'c',
      },
      new Date('2026-08-03T00:00:00.000Z'),
    );
    expect(e.occurredAt).not.toBe(e.recordedAt);
    expect(new Date(e.recordedAt) > new Date(e.occurredAt)).toBe(true);
  });

  it('derives a stable idempotency key from source + id + content', () => {
    const k = idempotencyKey({ source: 'rss', externalId: 'a', contentHash: 'h' });
    expect(k).toBe(idempotencyKey({ source: 'rss', externalId: 'a', contentHash: 'h' }));
    expect(k).not.toBe(idempotencyKey({ source: 'rss', externalId: 'a', contentHash: 'h2' }));
  });
});

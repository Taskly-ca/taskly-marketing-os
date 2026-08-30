/**
 * ONE SSE FRAME, WRITTEN IN ONE PLACE.
 *
 * This function was copy-pasted verbatim into `research-route.ts` and
 * `draft-route.ts`, and a third copy was about to land here. Four lines is a
 * silly thing to share right up until the moment one copy changes: SSE is a
 * line protocol, so the difference between `JSON.stringify(data)` and `data` is
 * the difference between one frame and a frame truncated at the first newline
 * followed by bytes the browser drops without an error. Three copies is three
 * chances to write the second version, on three routes whose payloads are all
 * multi-line prose.
 *
 * `id:` and `Last-Event-ID` deliberately do NOT live here yet. The answer-engine
 * plan lists reconnect-mid-answer as a separate fix, and adding a sequence
 * number to a helper that three routes share is a change to three protocols at
 * once — the routes that have no backlog to replay would advertise resumability
 * they cannot honour.
 */
import type { ServerResponse } from 'node:http';

/**
 * The narrowest thing a frame can be written to.
 *
 * `ServerResponse` satisfies it structurally, and so does an array-backed fake
 * — which is the entire reason it is not typed as `ServerResponse`. There is no
 * HTTP-level test harness in this repo and no jsdom, so an event sequence is
 * only provable if the sink can be a plain object.
 */
export interface SseSink {
  write(chunk: string): unknown;
}

export function send(res: SseSink, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The headers every stream in this console opens with.
 *
 * `no-cache` is not superstition: an intermediary that buffers an event stream
 * turns a 60-second run with visible progress into a 60-second blank page that
 * delivers everything at once, which is exactly the failure the streaming was
 * built to avoid.
 */
export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

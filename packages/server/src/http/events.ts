/**
 * Server-Sent Events responses.
 *
 * A handler that streams answers with `{ events: stream }` instead of a
 * body. Once the response head is sent (200, `text/event-stream`), the
 * stream is started with a sink: it sends events, each a name and a JSON
 * payload on one `data:` line, until it closes the sink. It returns a
 * function the app calls instead if the stream is cut short: the client
 * went away, or the server is shutting down. Errors must be thrown before
 * the stream starts; once it has, the only way to report one is an event.
 *
 * A comment line is sent every `SSE_HEARTBEAT_MS` so that idle streams are
 * not closed by proxies and load balancers (the AWS ALB's idle timeout is
 * 60 seconds).
 */

export const SSE_HEARTBEAT_MS = 15_000;

export interface ServerSentEvent {
  /** The event name, e.g. `tick`. */
  readonly event: string;
  /** Sent as JSON. */
  readonly data: unknown;
  /** The event id; clients send the last one back as `Last-Event-ID` when they reconnect. */
  readonly id?: string;
}

export interface EventSink {
  send(event: ServerSentEvent): void;
  /** Ends the response; later sends are ignored. */
  close(): void;
}

/** Starts a stream; returns what to do if it is cut short before it closes the sink. */
export type EventStream = (sink: EventSink) => () => void;

/** One event in the wire format. */
export function formatEvent(event: ServerSentEvent): string {
  // JSON never contains a raw line break, so the payload is always one `data:` line.
  const id = event.id === undefined ? "" : `id: ${event.id}\n`;
  return `event: ${event.event}\n${id}data: ${JSON.stringify(event.data)}\n\n`;
}

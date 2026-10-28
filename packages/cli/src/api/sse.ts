/**
 * A small Server-Sent Events reader (docs/spec/cli-api.md, HTTP client): the
 * stream is read with `fetch` rather than EventSource, which cannot send an
 * `Authorization` header, and split into events here.
 */

export interface StreamEvent {
  /** The event name; `message` when the server gave none. */
  readonly event: string;
  /** This event's own id; unlike EventSource's lastEventId, it does not carry over to later events. */
  readonly id?: string;
  readonly data: string;
}

/**
 * The events of a `text/event-stream` body, in order, until the body ends.
 * Comment lines (the server's heartbeats) are skipped. A read failure, such as
 * a dropped connection, is thrown from the iteration.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length > 0) yield { event: event ?? "message", ...(id === undefined ? {} : { id }), data: data.join("\n") };
        event = undefined;
        id = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }
}

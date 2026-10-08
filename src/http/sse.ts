import { JSONPath } from "jsonpath-plus";

/** Where the text delta lives in the event payload of the common streaming APIs. */
const TEXT_PATHS = [
  "$.choices[0].delta.content",
  "$.delta.text",
  "$.choices[0].text",
  "$.text",
  "$.content",
  "$.token",
  "$.answer",
  "$.response",
];
const MAX_EVENTS_KEPT = 50;

export function isEventStream(contentType: string | null): boolean {
  return /text\/event-stream/i.test(contentType ?? "");
}

function textDelta(payload: unknown, textPath?: string): string | undefined {
  for (const path of textPath ? [textPath] : TEXT_PATHS) {
    const hit = JSONPath({ path, json: payload as object, wrap: false });
    if (typeof hit === "string") {
      return hit;
    }
  }
  return undefined;
}

/**
 * Fold a `text/event-stream` body into one JSON document, so capture, asserts and
 * `jsonPathSelect` work on a streamed answer as on any other:
 * `{ text, eventCount, events }`. `text` is the deltas joined; `events` keeps only
 * what was not a text delta (sources, usage, stop reason…) — the hundreds of token
 * events are the answer already.
 */
export function foldEventStream(raw: string, textPath?: string): string {
  let text = "";
  let eventCount = 0;
  const events: unknown[] = [];

  for (const block of raw.split(/\r?\n\r?\n/)) {
    let name: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("event:")) {
        name = line.slice(6).trim();
      }
    }
    const data = dataLines.join("\n");
    if (data === "" || data === "[DONE]") {
      continue;
    }
    eventCount++;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      // A stream of bare tokens.
      text += data;
      continue;
    }
    const delta =
      payload !== null && typeof payload === "object"
        ? textDelta(payload, textPath)
        : undefined;
    if (delta !== undefined) {
      text += delta;
    } else if (events.length < MAX_EVENTS_KEPT) {
      events.push(name ? { event: name, data: payload } : payload);
    }
  }
  return JSON.stringify({ text, eventCount, events });
}

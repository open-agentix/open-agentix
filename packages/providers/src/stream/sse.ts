import { StreamError } from './types.js';

export interface SseEvent {
  /** `event:` field, `message` when absent. */
  event: string;
  /** `data:` lines joined with `\n`. */
  data: string;
}

export interface SseParserLimits {
  maxLineBytes: number;
  maxEventBytes: number;
}

/** Event names accepted by the writer: no whitespace, colon or control characters. */
const EVENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Incremental SSE parser (WHATWG event stream rules). Accepts arbitrary chunk boundaries
 * (partial lines, split UTF-8 sequences, CR LF split across chunks), enforces line and event size
 * limits while parsing so memory stays bounded, and ignores comments and unknown fields.
 */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  private partial: string[] = [];
  private partialLen = 0;
  private skipLf = false;
  private first = true;
  private eventName = '';
  private dataLines: string[] = [];
  private eventBytes = 0;
  private pendingEvent = false;

  constructor(private readonly limits: SseParserLimits) {}

  /** Feeds raw bytes and returns the events completed by them. */
  push(chunk: Uint8Array): SseEvent[] {
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new StreamError('invalid_utf8', 'upstream stream contains invalid UTF-8');
    }
    return this.pushText(text);
  }

  /** True when bytes of an unfinished line or event are buffered. */
  get hasPending(): boolean {
    return this.partialLen > 0 || this.pendingEvent;
  }

  /** Flushes the decoder at the end of the stream; throws on invalid trailing UTF-8. */
  end(): void {
    try {
      const rest = this.decoder.decode();
      if (rest) this.pushText(rest);
    } catch (e) {
      if (e instanceof StreamError) throw e;
      throw new StreamError('invalid_utf8', 'upstream stream ends inside a UTF-8 sequence');
    }
  }

  private pushText(input: string): SseEvent[] {
    let text = input;
    const events: SseEvent[] = [];
    if (this.first && text.length > 0) {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    if (this.skipLf && text.length > 0) {
      this.skipLf = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const piece = text.slice(start, i);
      let line = piece;
      if (this.partial.length > 0) {
        this.partial.push(piece);
        line = this.partial.join('');
        this.partial = [];
        this.partialLen = 0;
      }
      this.checkLine(line.length);
      if (
        line.length * 3 > this.limits.maxLineBytes &&
        Buffer.byteLength(line, 'utf8') > this.limits.maxLineBytes
      ) {
        throw new StreamError('line_too_large', 'upstream SSE line exceeds the line size limit');
      }
      this.processLine(line, events);
      if (c === 13) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 10) i++;
        } else this.skipLf = true;
      }
      start = i + 1;
    }
    if (start < text.length) {
      const tail = text.slice(start);
      this.partial.push(tail);
      this.partialLen += tail.length;
      // The UTF-16 length never exceeds the byte count; the exact byte check runs per completed line.
      this.checkLine(this.partialLen);
    }
    return events;
  }

  private checkLine(utf16Length: number): void {
    // Cheap bound first (a UTF-8 byte count is never below the UTF-16 length), exact check after.
    if (utf16Length > this.limits.maxLineBytes) {
      throw new StreamError('line_too_large', 'upstream SSE line exceeds the line size limit');
    }
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        events.push({ event: this.eventName || 'message', data: this.dataLines.join('\n') });
      }
      this.eventName = '';
      this.dataLines = [];
      this.eventBytes = 0;
      this.pendingEvent = false;
      return;
    }
    if (line.charCodeAt(0) === 58) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field !== 'data' && field !== 'event') return; // id, retry and unknown fields are ignored
    this.pendingEvent = true;
    this.eventBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (this.eventBytes > this.limits.maxEventBytes) {
      throw new StreamError('event_too_large', 'upstream SSE event exceeds the event size limit');
    }
    if (field === 'event') this.eventName = value;
    else this.dataLines.push(value);
  }
}

/**
 * Serializes one event for a client. The event name is validated and `data` is split on every
 * line terminator, so a payload can never terminate the frame early or inject another field or
 * event (frame smuggling).
 */
export function formatSseEvent(event: { event?: string | undefined; data: string }): string {
  let out = '';
  if (event.event !== undefined) {
    if (!EVENT_NAME.test(event.event)) throw new TypeError('invalid SSE event name');
    out += `event: ${event.event}\n`;
  }
  for (const line of event.data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** SSE comment line for keep-alives; the text cannot contain line terminators. */
export function formatSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

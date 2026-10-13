export interface SseEvent<T = unknown> {
  id?: string;
  event: string;
  data: T;
}

export type SseEventHandler<T = unknown> = (event: SseEvent<T>) => void;

/**
 * Robust Server-Sent Events (SSE) stream buffer parser.
 * Handles fragmented network chunks, multi-line data payloads,
 * and standard event / id framing.
 */
export class SseStreamParser {
  private buffer = '';
  private currentEvent = 'message';
  private currentId?: string;
  private currentDataLines: string[] = [];

  constructor(private readonly onEvent: SseEventHandler) {}

  /**
   * Feed a new raw string chunk from the readable stream reader.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // Normalize Windows CRLF to LF
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Blank line indicates dispatch of current event buffer
    if (line.trim() === '') {
      this.dispatch();
      return;
    }

    // Comment lines starting with colon are ignored (heartbeats or comments)
    if (line.startsWith(':')) {
      return;
    }

    const colonIndex = line.indexOf(':');
    let field = line;
    let value = '';

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        this.currentEvent = value;
        break;
      case 'data':
        this.currentDataLines.push(value);
        break;
      case 'id':
        this.currentId = value;
        break;
      default:
        // Ignore unknown fields per SSE specification
        break;
    }
  }

  private dispatch(): void {
    if (this.currentDataLines.length === 0) {
      this.currentEvent = 'message';
      return;
    }

    const rawData = this.currentDataLines.join('\n');
    let parsedData: unknown = rawData;

    try {
      parsedData = JSON.parse(rawData);
    } catch {
      // Keep as raw string if not JSON
    }

    this.onEvent({
      id: this.currentId,
      event: this.currentEvent,
      data: parsedData,
    });

    // Reset buffer for next event
    this.currentDataLines = [];
    this.currentEvent = 'message';
  }

  /**
   * Flush any remaining buffered data at end of stream.
   */
  flush(): void {
    if (this.buffer.trim().length > 0) {
      this.processLine(this.buffer);
      this.buffer = '';
    }
    this.dispatch();
  }
}

export type MessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'sticker'
  | 'document'
  | 'system'
  | 'deleted'
  | 'omitted';

export interface Message {
  /** ISO 8601 local, no timezone: 2026-07-23T09:47:18 (D-18) */
  timestamp_iso: string;
  type: MessageType;
  /** Raw sender string (incl. ~ prefix, phone bidi wrappers) — preserved verbatim (D-09, PARSE-05) */
  author: string;
  /** Message body (markers stripped); may be empty */
  text: string;
  /** Media filename or '' (D-14) */
  media: string;
  /** Per-URL fetched page titles (enrichment); `{}` when absent/disabled. */
  urlTitles?: Record<string, string>;
}

import type { Message } from '../whatsapp/types';

/** What an old wa-backup / memory-archive output file gives back. */
export interface LegacyArchive {
  /** Messages in file order (the canonical CSV order). */
  messages: Message[];
  /** Chat display name, when the file records it (JSON / HTML do; CSV does not). */
  chatName?: string;
  /** Envelope version: 0 for files written before `schemaVersion` existed. */
  schemaVersion: number;
  /** Writer identity, when recorded (schema >= 1). */
  generator?: { name: string; version: string };
  /** Source format the archive was read from. */
  format: 'json' | 'html' | 'csv';
}

export class LegacyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyFormatError';
  }
}

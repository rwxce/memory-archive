/**
 * Readers for outputs written by wa-backup / memory-archive (messages.json,
 * messages.html, messages.csv). Platform-neutral: text in, messages out.
 */
export * from './types';
export { readLegacyJson, legacyArchiveFromEnvelope } from './json';
export { readLegacyHtml, extractChatDataJson } from './html';
export { readLegacyCsv } from './csv';
export { readLegacyOutput, MARKDOWN_NOT_SUPPORTED } from './read';

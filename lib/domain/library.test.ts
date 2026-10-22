import { describe, expect, test } from 'vitest';
import type { MessageType as ImporterMessageType } from '../importers/whatsapp/types';
import {
  isLocalTimestamp,
  isMessageType,
  isSha256Hex,
  isUuid,
  MESSAGE_TYPES,
  type MessageType,
} from './library';

describe('library invariants', () => {
  test('isUuid accepts canonical lowercase UUIDs only', () => {
    expect(isUuid('3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b')).toBe(true);
    expect(isUuid('3F2B8C1E-5D4A-4B6F-9A7E-0C1D2E3F4A5B')).toBe(false);
    expect(isUuid('3f2b8c1e5d4a4b6f9a7e0c1d2e3f4a5b')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  test('isSha256Hex requires 64 lowercase hex characters', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex('g'.repeat(64))).toBe(false);
  });

  test('isLocalTimestamp is a zone-less ISO wall-clock time', () => {
    expect(isLocalTimestamp('2026-07-23T09:47:18')).toBe(true);
    expect(isLocalTimestamp('2026-07-23T09:47:18Z')).toBe(false);
    expect(isLocalTimestamp('2026-07-23 09:47:18')).toBe(false);
    expect(isLocalTimestamp('23/07/2026 09:47')).toBe(false);
  });

  test('message types match the importer vocabulary', () => {
    // Compile-time check: both unions must be mutually assignable.
    const fromImporter: ImporterMessageType[] = [...MESSAGE_TYPES];
    const fromDomain: MessageType[] = fromImporter;
    expect(fromDomain).toHaveLength(9);
    expect(isMessageType('photo')).toBe(true);
    expect(isMessageType('gif')).toBe(false);
  });
});

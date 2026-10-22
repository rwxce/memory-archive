import { describe, expect, test } from 'vitest';
import { blobSize } from './conversation-media';
import { createTestLibrary } from './test-client';

describe('blobSize', () => {
  test('is the stored size, undefined for an absent or malformed hash', async () => {
    const { deps } = await createTestLibrary();
    const { sha256 } = await deps.blobStore.put(new Uint8Array(1234));
    expect(await blobSize(deps, sha256)).toBe(1234);
    expect(await blobSize(deps, 'ab'.repeat(32))).toBeUndefined();
    expect(await blobSize(deps, '../etc')).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { act, useState } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { NewMessage } from '@/lib/domain/library';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { getMessageWindow } from '@/lib/usecases/conversation-view';
import { useLibrary } from './use-library';
import { useMessageSource, type MessageSourceState } from './use-message-source';

const CONV = '00000000-0000-4000-8000-000000000020';
let seen: { state: MessageSourceState; retry(): void } | undefined;

let setEnabled: (value: boolean) => void = () => {};
function Probe({ id, enabled: initial }: { id: number; enabled: boolean }) {
  useLibrary();
  const [enabled, set] = useState(initial);
  setEnabled = set;
  seen = useMessageSource(CONV, id, enabled);
  return null;
}

const message: NewMessage = {
  fingerprint: '1'.padStart(64, '0'),
  sentAt: '2026-01-01T10:00:00',
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: 'synthetic',
  mediaSha256: null,
  mediaName: '',
};

describe('useMessageSource', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  async function setup() {
    const lib = await createTestLibrary();
    await lib.client.call('importMessages', {
      batchId: '00000000-0000-4000-8000-000000000100',
      conversationId: CONV,
      source: 'whatsapp',
      sourceLabel: 'Ana.zip',
      now: '2026-02-01T12:00:00Z',
      blobs: [],
      messages: [message],
      newConversation: { title: 'Chat', sourceKey: 'a', isGroup: false, profileIds: [] },
    });
    const [{ id }] = await getMessageWindow(lib.deps, CONV, 0, 1);
    return { lib, id };
  }

  test('reads nothing until enabled, then loads once and keeps the result', async () => {
    const { lib, id } = await setup();
    let calls = 0;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => {
      if (method === 'getMessageSource') calls++;
      return call(method, params);
    };
    view = await renderWithLibrary(<Probe id={id} enabled={false} />, { lib });
    await settle();
    expect(seen!.state.status).toBe('idle');
    expect(calls).toBe(0);

    await act(async () => setEnabled(true));
    await settle();
    expect(seen!.state).toMatchObject({ status: 'ready', source: { source: 'whatsapp', sourceLabel: 'Ana.zip', importedAt: '2026-02-01T12:00:00Z' } });

    await act(async () => setEnabled(false));
    await act(async () => setEnabled(true));
    await settle();
    expect(seen!.state.status).toBe('ready');
    expect(calls).toBe(1);
  });

  test('an unknown message is not-found and an unreadable one is an error that retry can clear', async () => {
    const { lib, id } = await setup();
    view = await renderWithLibrary(<Probe id={id + 999} enabled />, { lib });
    await settle();
    expect(seen!.state.status).toBe('not-found');
    view.unmount();

    let fail = true;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) =>
      method === 'getMessageSource' && fail ? Promise.reject(new Error('disk')) : call(method, params);
    view = await renderWithLibrary(<Probe id={id} enabled />, { lib });
    await settle();
    expect(seen!.state.status).toBe('error');
    fail = false;
    await act(async () => seen!.retry());
    await settle();
    expect(seen!.state.status).toBe('ready');
  });
});

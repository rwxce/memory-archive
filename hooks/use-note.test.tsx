import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, useState } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import { CHAT, seedNotes } from '@/components/notes-fixture';
import { NOTE_MAX } from '@/lib/domain/profile';
import { getNote } from '@/lib/usecases/notes';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { useLibrary } from './use-library';
import { useNote, type NoteController } from './use-note';

let seen: NoteController | undefined;
let setEnabled: (value: boolean) => void = () => {};
const changed = vi.fn();

function Probe({ messageId, enabled: initial }: { messageId: number; enabled: boolean }) {
  useLibrary();
  const [enabled, set] = useState(initial);
  setEnabled = set;
  seen = useNote({ kind: 'message', conversationId: CHAT, messageId }, enabled, { onChanged: changed });
  return null;
}

describe('useNote', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    changed.mockClear();
  });

  async function setup(enabled: boolean) {
    const lib = await createTestLibrary();
    const { chatIds } = await seedNotes(lib);
    let reads = 0;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => {
      if (method === 'getNote') reads++;
      return call(method, params);
    };
    view = await renderWithLibrary(<Probe messageId={chatIds[0]} enabled={enabled} />, { lib });
    await settle();
    return { lib, id: chatIds[0], reads: () => reads };
  }

  test('reads nothing until enabled, reads once, and keeps the result', async () => {
    const { reads } = await setup(false);
    expect(seen!.state.status).toBe('idle');
    expect(reads()).toBe(0);
    await act(async () => setEnabled(true));
    await settle();
    expect(seen!.state).toEqual({ status: 'ready', note: null });
    await act(async () => setEnabled(false));
    await act(async () => setEnabled(true));
    await settle();
    expect(reads()).toBe(1);
  });

  test('save stores the trimmed text, becomes the state and reports the change; an empty text deletes', async () => {
    const { lib, id } = await setup(true);
    await act(async () => seen!.save('  hello  '));
    await settle();
    expect(seen!.state).toMatchObject({ status: 'ready', note: { body: 'hello' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'hello' }));
    expect((await getNote(lib.deps, { kind: 'message', conversationId: CHAT, messageId: id }))?.body).toBe('hello');
    await act(async () => seen!.save('   '));
    await settle();
    expect(seen!.state).toEqual({ status: 'ready', note: null });
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  test('a text that is too long is invalid; any other failure is failed; neither reports a change', async () => {
    const { lib } = await setup(true);
    let outcome: unknown;
    await act(async () => {
      outcome = await seen!.save('x'.repeat(NOTE_MAX + 1));
    });
    expect(outcome).toEqual({ status: 'invalid' });
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'setNote' ? Promise.reject(new Error('disk')) : call(method, params));
    await act(async () => {
      outcome = await seen!.save('ok');
    });
    expect(outcome).toEqual({ status: 'failed' });
    expect(changed).not.toHaveBeenCalled();
  });

  test('a failed read is an error that retry clears', async () => {
    const lib = await createTestLibrary();
    const { chatIds } = await seedNotes(lib);
    let fail = true;
    const call = lib.client.call.bind(lib.client) as (m: string, p?: unknown) => Promise<unknown>;
    (lib.client as { call: unknown }).call = (method: string, params?: unknown) => (method === 'getNote' && fail ? Promise.reject(new Error('disk')) : call(method, params));
    view = await renderWithLibrary(<Probe messageId={chatIds[0]} enabled />, { lib });
    await settle();
    expect(seen!.state.status).toBe('error');
    fail = false;
    await act(async () => seen!.retry());
    await settle();
    expect(seen!.state.status).toBe('ready');
  });
});

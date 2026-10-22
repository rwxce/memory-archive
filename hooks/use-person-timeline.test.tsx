import { afterEach, describe, expect, test } from 'vitest';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import type { NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { createTestLibrary } from '@/lib/usecases/test-client';
import { savePosition } from './conversation-position';
import { useLibrary } from './use-library';
import { timelinePositionKey, usePersonTimeline, type PersonTimelineState } from './use-person-timeline';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
let seen: PersonTimelineState | undefined;

function Probe({ id, date }: { id: string | null; date: string | null }) {
  useLibrary();
  seen = usePersonTimeline(id, date).state;
  return null;
}

const message = (n: number, sentAt: string): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt,
  ordinal: 0,
  type: 'text',
  participantName: 'Ana',
  body: `m${n}`,
  mediaSha256: null,
  mediaName: '',
});

describe('usePersonTimeline', () => {
  let view: Rendered | undefined;
  afterEach(() => {
    view?.unmount();
    sessionStorage.clear();
  });

  async function setup() {
    const lib = await createTestLibrary();
    const ana = await createProfile(lib.deps, { displayName: 'Ana' });
    for (const [n, day] of [[1, '2026-03-01'], [2, '2026-03-05']] as const) {
      await lib.client.call('importMessages', {
        batchId: uuid(0x100 + n),
        conversationId: uuid(0x20 + n),
        source: 'whatsapp',
        sourceLabel: 'x.zip',
        now: '2026-04-01T12:00:00Z',
        blobs: [],
        messages: [message(n, `${day}T10:00:00`)],
        newConversation: { title: `Chat ${n}`, sourceKey: `k${n}`, isGroup: false, profileIds: [ana.id] },
      });
    }
    return { lib, ana };
  }

  test('opens at the end, at a date, or where it was left (the date wins)', async () => {
    const { lib, ana } = await setup();
    view = await renderWithLibrary(<Probe id={ana.id} date={null} />, { lib });
    await settle();
    expect(seen).toMatchObject({ status: 'ready', timeline: { person: { name: 'Ana' }, conversations: 2, bounds: { count: 2 }, start: { kind: 'end' } } });
    view.unmount();

    view = await renderWithLibrary(<Probe id={ana.id} date="2026-03-02" />, { lib });
    await settle();
    expect(seen).toMatchObject({ timeline: { start: { kind: 'index', index: 1 } } });
    view.unmount();

    savePosition(timelinePositionKey(ana.id), { index: 0, within: 12 });
    view = await renderWithLibrary(<Probe id={ana.id} date={null} />, { lib });
    await settle();
    expect(seen).toMatchObject({ timeline: { start: { kind: 'index', index: 0, within: 12 } } });
  });

  test('a missing, malformed or unknown id is not-found', async () => {
    const { lib } = await setup();
    for (const id of [null, 'nope', uuid(0x99)]) {
      view = await renderWithLibrary(<Probe id={id} date={null} />, { lib });
      await settle();
      expect(seen).toEqual({ status: 'not-found' });
      view.unmount();
    }
    view = undefined;
  });
});

import { describe, expect, test } from 'vitest';
import { NO_RANGE, ViewerModel } from './model';
import { queryTerms } from './text';
import { conversation, manyMessages, message, viewerData } from './test-data';

const control = { cancelled: () => false, yieldToUi: () => Promise.resolve() };

function model() {
  return new ViewerModel(
    viewerData({
      profiles: [
        { id: 'p1', displayName: 'Ada', relationship: '', description: '' },
        { id: 'p2', displayName: 'Bo', relationship: '', description: '' },
      ],
      conversations: [
        conversation({ id: 'a', title: 'Old', profileIds: ['p1'], messages: [message({ sentAt: '2019-05-01T09:00:00', text: 'Camí a casa' })] }),
        conversation({
          id: 'b',
          title: 'New',
          profileIds: ['p1', 'p2'],
          messages: [
            message({ sentAt: '2023-12-31T23:59:00', text: 'happy new year' }),
            message({ sentAt: '2024-01-01T00:01:00', text: 'cami again', mediaName: 'Photo 1.jpg' }),
            message({ sentAt: '2024-02-10T12:00:00', text: 'nothing' }),
          ],
        }),
        conversation({ id: 'c', title: 'Bo only', profileIds: ['p2'], messages: [message({ sentAt: '2022-01-01T00:00:00', text: 'x' })] }),
      ],
    }),
  );
}

describe('ViewerModel', () => {
  test('lists the profile conversations, most recent first', () => {
    const m = model();
    expect(m.summaries('p1', NO_RANGE).map((s) => s.title)).toEqual(['New', 'Old']);
    expect(m.summaries(null, NO_RANGE)).toHaveLength(3);
    expect(m.summaries('p2', NO_RANGE).map((s) => s.title)).toEqual(['New', 'Bo only']);
  });

  test('a date range keeps only conversations and counts inside it (inclusive days)', () => {
    const m = model();
    const s = m.summaries(null, { from: '2024-01-01', to: '2024-01-01' });
    expect(s.map((x) => [x.title, x.count])).toEqual([['New', 1]]);
    expect(m.summaries(null, { from: '2025-01-01', to: null })).toEqual([]);
    expect(m.summaries(null, { from: '2024-02-01', to: '2024-01-01' })).toEqual([]);
  });

  test('visible positions and position lookup', () => {
    const m = model();
    const v = m.visible(1, { from: '2024-01-01', to: null });
    expect([...v]).toEqual([1, 2]);
    expect(m.positionOf(v, 2)).toBe(1);
    expect(m.positionOf(v, 99)).toBe(2);
  });

  test('timeline groups by month with the first position', () => {
    const t = model().timeline(1, NO_RANGE);
    expect(t).toEqual([
      { year: 2023, month: 12, pos: 0, count: 1 },
      { year: 2024, month: 1, pos: 1, count: 1 },
      { year: 2024, month: 2, pos: 2, count: 1 },
    ]);
  });

  test('search is accent- and case-insensitive, covers file names, and respects profile, scope and dates', async () => {
    const m = model();
    const base = { terms: queryTerms('CAMI'), profileId: null, onlyConv: null, range: NO_RANGE, limit: 50 };
    expect((await m.search(base, control))?.hits).toEqual([{ conv: 0, msg: 0 }, { conv: 1, msg: 1 }]);
    expect((await m.search({ ...base, profileId: 'p2' }, control))?.hits).toEqual([{ conv: 1, msg: 1 }]);
    expect((await m.search({ ...base, onlyConv: 0 }, control))?.hits).toEqual([{ conv: 0, msg: 0 }]);
    expect((await m.search({ ...base, range: { from: '2024-01-01', to: null } }, control))?.hits).toEqual([{ conv: 1, msg: 1 }]);
    expect((await m.search({ ...base, terms: queryTerms('photo 1') }, control))?.hits).toEqual([{ conv: 1, msg: 1 }]);
    expect((await m.search({ ...base, terms: queryTerms('cami again') }, control))?.hits).toHaveLength(1);
    expect((await m.search({ ...base, terms: [] }, control))?.hits).toEqual([]);
  });

  test('search stops at the limit and can be cancelled', async () => {
    const big = new ViewerModel(viewerData({ conversations: [conversation({ messages: manyMessages(20000, () => 'needle') })] }));
    const opts = { terms: ['needle'], profileId: null, onlyConv: null, range: NO_RANGE, limit: 10 };
    const r = await big.search(opts, control);
    expect(r?.hits).toHaveLength(10);
    expect(r?.truncated).toBe(true);
    let calls = 0;
    const cancelled = await big.search({ ...opts, terms: ['nomatch'] }, { cancelled: () => calls > 0, yieldToUi: async () => void calls++ });
    expect(cancelled).toBeNull();
  });
});

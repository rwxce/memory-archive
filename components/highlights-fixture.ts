import type { Findings } from '@/lib/domain/highlights';
import { importFindings } from '@/lib/usecases/highlights';
import { CHAT, GROUP, seedNotes, type Lib } from './notes-fixture';

/** Synthetic highlights for the screen tests: the notes fixture (a chat of 4 messages, a group of 1) plus findings files. */
export const fp = (n: number) => n.toString(16).padStart(64, '0');
export const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">';

export const hl = (id: string, category: 'moment' | 'pattern' | 'interest', messages: number[], extra: Record<string, string> = {}) => ({
  id,
  category,
  title: `Title ${id}`,
  summary: `Summary ${id}`,
  messages: messages.map(fp),
  createdBy: 'test',
  createdAt: '2026-02-01T10:00:00Z',
  ...extra,
});

export const findingsOf = (highlights: Findings['highlights'], name = 'Chat', messageCount = 4): Findings => ({
  version: 1,
  conversation: { name, messageCount, firstFingerprint: fp(1) },
  highlights,
});

export async function seedHighlights(lib: Lib) {
  const seeded = await seedNotes(lib);
  await importFindings(
    lib.deps,
    CHAT,
    findingsOf([hl('m1', 'moment', [1, 2]), hl('m2', 'moment', [4], { title: HOSTILE_TITLE }), hl('p1', 'pattern', [3]), hl('i1', 'interest', [2, 3, 4])]),
  );
  return seeded;
}

export { CHAT, GROUP };
